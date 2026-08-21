'use strict';

/**
 * Scenes - a map image plus the tokens standing on it.
 *
 * Token coordinates are stored in *grid cells*, not pixels, so the same scene
 * renders correctly at any zoom or canvas size. Snapping is the client's job.
 *
 * Permissions: this campaign's DM owns the scene (image, grid, which tokens
 * exist and who they belong to). A player may only move a token whose ownerId
 * is theirs. Both are decided by role *in this campaign* - the same person may
 * be the DM here and a player at the next table.
 */

const express = require('express');
const crypto = require('node:crypto');
const store = require('../store');
// Nothing on this router goes out to everybody as one payload any more: a scene
// carries its tokens, and who may see which is a question about the reader.
const { broadcastPerActor } = require('../realtime');
const { requireUser } = require('../auth');
const {
  scoped,
  requireDm,
  isDm,
  canMoveToken,
  canSeeToken,
  canSeePin,
  canEditPin,
  sceneAsSeenBy,
  canViewSheet,
  canEditSheet,
} = require('../campaigns');
const { sanitizeFog, fogOn, tokensSeenThroughFog } = require('../fog');
const sheetLink = require('../sheetLink');
const { pickAttacks } = require('../sheetSchema');
const {
  rootIdOf,
  locateToken,
  placementsOf,
  patchEverywhere,
  removeEverywhere,
  countCopies,
  copyLabelFor,
} = require('../tokenCopies');

const COLLECTION = 'scenes';
const router = express.Router({ mergeParams: true });

const scenesOf = (req) => scoped(req.campaignId, COLLECTION);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * A scene is a map of a fixed pixel size with a grid laid over it.
 *
 * `width`/`height` are the map's own dimensions and `gridSize` is how many of
 * those pixels one cell spans - so the GM can retune the grid to match the art
 * without the map changing size. Column and row counts are *derived* from that
 * ratio rather than stored, which is what keeps the two from contradicting
 * each other.
 *
 * `gridOffsetX`/`gridOffsetY` are where the first cell's corner sits, for a map
 * that came with a grid drawn on it: getting the size right lines the cells up,
 * and the offset then slides them onto the ones in the picture.
 */
function sanitizeScene(body = {}) {
  const { name = 'New Scene', imageUrl = '', gridSize = 70 } = body;
  // Older scenes described their size as cols/rows instead of pixels.
  const fallbackW = num(body.cols, 0) * num(gridSize, 70) || 1200;
  const fallbackH = num(body.rows, 0) * num(gridSize, 70) || 840;
  const cell = clamp(num(gridSize, 70), 8, 500);
  // A grid repeats, so a nudge of one whole cell in either direction reaches
  // every alignment there is - past that you are back where you started.
  const offset = (v) => clamp(Math.round(num(v, 0)), -cell, cell);
  return {
    name: String(name).slice(0, 120),
    imageUrl: String(imageUrl).slice(0, 500),
    gridSize: cell, // map px per cell
    gridOffsetX: offset(body.gridOffsetX),
    gridOffsetY: offset(body.gridOffsetY),
    // Absent means on: every scene that existed before this flag did had a
    // grid, and they should keep it.
    gridOn: body.gridOn !== false,
    ...gridLook(body),
    // Fog is deliberately *not* here. Everything in this function is overwritten
    // by any PUT of the scene, and a client that had never heard of fog would
    // turn it off by saving a name change. It has a route of its own below.
    width: clamp(Math.round(num(body.width, 0) || fallbackW), 32, 12000),
    height: clamp(Math.round(num(body.height, 0) || fallbackH), 32, 12000),
  };
}

/**
 * How the grid is drawn, as against where it sits.
 *
 * Four fields the DM sets in Grid settings. Every default is what the grid
 * looked like before any of them existed, so a scene saved by an older version
 * comes back looking exactly as it did rather than as a design decision nobody
 * made: white lines, one pixel wide, at 13 percent.
 *
 * `gridContrast` is the odd one. With it on the colour is ignored and the lines
 * are drawn by inverting whatever is beneath them, per pixel, so the grid is
 * legible on a map that is white in one corner and black in the other. It is a
 * flag rather than a colour because there is no colour that means it; the
 * client draws it with a blend mode (see .grid-overlay in styles.css).
 */
function gridLook(body = {}) {
  return {
    gridColor: hexOr(body.gridColor, '#ffffff'),
    // Percent, and floored above zero: an invisible grid is what the Show grid
    // checkbox is for, and a slider that can reach the same state is a way to
    // lose the grid with no clue as to why.
    gridOpacity: clamp(Math.round(num(body.gridOpacity, 13)), 2, 100),
    // Whole pixels. Past about six the lines stop being a grid and start being
    // a lattice the map shows through.
    gridThickness: clamp(Math.round(num(body.gridThickness, 1)), 1, 6),
    gridContrast: body.gridContrast === true,
  };
}

const HEX = /^#[0-9a-f]{6}$/i;
const hexOr = (value, fallback) => (HEX.test(String(value)) ? String(value) : fallback);

/**
 * A whole-number stat the DM may simply not have filled in.
 *
 * Null rather than 0, because on a token those say different things: 0 hit
 * points is a creature that has just dropped, null is one nobody is counting.
 * An empty string arrives from a cleared form field and means the same as null.
 */
function statOrNull(value, lo, hi) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? clamp(Math.round(n), lo, hi) : null;
}

/**
 * Initiative, and the roll behind it.
 *
 * The total is what the order is read from, so it stays the authoritative
 * field - but when both halves are known the total is *derived* from them
 * rather than trusted alongside them. Two numbers that are supposed to add up
 * to a third will eventually disagree if all three are stored independently,
 * and the one that would be wrong is the one everything else reads.
 *
 * Half a breakdown is no breakdown: a die with no modifier tells a tie nothing,
 * so both or neither are kept and a lone half is dropped back to a bare total.
 */
function rolledInitiative(total, die, mod) {
  const d = statOrNull(die, -99, 999);
  const m = statOrNull(mod, -99, 999);
  if (d !== null && m !== null) {
    return { initiative: clamp(d + m, -99, 999), initiativeDie: d, initiativeMod: m };
  }
  return { initiative: statOrNull(total, -99, 999), initiativeDie: null, initiativeMod: null };
}

/**
 * Current, total and temporary hit points, decided together.
 *
 * Current only means something measured against a total - it's what draws the
 * bar - so a token without a total has no hit points at all rather than a
 * number floating free. Given a total but no current, it starts at full: that's
 * the state a creature is in when it walks onto the map.
 *
 * Temporary points hang off the same decision, for the same reason: they are a
 * cushion in front of hit points, and a cushion in front of nothing is not a
 * number anybody can use. They are *not* clamped to the total, though, because
 * they genuinely are not part of it - a creature on 4 of 12 with 10 temporary
 * points has fourteen points between it and the floor, and clamping would be
 * the sheet quietly disagreeing with the rules.
 *
 * Null and zero are kept apart on the way in and mean the same thing on the way
 * out: nothing is drawn for either. Zero is stored where the DM typed a zero,
 * which is how clearing the field survives a round trip.
 */
function hitPoints(maxHp, hp, tempHp) {
  const max = statOrNull(maxHp, 0, 9999);
  if (max === null) return { maxHp: null, hp: null, tempHp: null };
  const current = statOrNull(hp, 0, max);
  return {
    maxHp: max,
    hp: current === null ? max : current,
    tempHp: statOrNull(tempHp, 0, 9999),
  };
}

function sanitizeToken(body = {}, existing = {}) {
  const {
    label = existing.label ?? 'Token',
    // Whether that label is written on the board all the time. False for every
    // token that has never been asked - which is every token made before this
    // field existed, and is the answer they were already getting.
    showNameplate = existing.showNameplate ?? false,
    color = existing.color ?? '#58a6ff',
    // Null means "whatever the stylesheet draws" - the dark ring every token
    // had before this was a choice. Kept nullable so old tokens don't have to
    // be migrated into an explicit colour they never picked.
    //
    // Note that these are *destructuring defaults*, which apply only when the
    // key is absent or undefined. That is load-bearing here: an explicit null
    // has to survive, because it is how the form says "remove the border".
    // Rewriting this row as `body.borderColor ?? existing.borderColor` would
    // look equivalent and quietly make removal impossible - which is precisely
    // the bug the Tokens tab had (see sanitizeLook in routes/campaignTokens.js).
    borderColor = existing.borderColor ?? null,
    // A token's face. Empty means it shows its name instead.
    imageUrl = existing.imageUrl ?? '',
    /**
     * Whether the players can see this token at all.
     *
     * The DM's switch for the ambush in the trees: false and the token is on
     * the board, moving and rolling initiative, for the DM alone. True unless
     * somebody says otherwise, which covers a new token and every token made
     * before the switch existed - all of which were already visible.
     *
     * Only the DM may set it, and that is checked in the routes below rather
     * than here: this function is also how a copy inherits its source's fields,
     * and a rule written into it would be a rule the paste had to work around.
     */
    visible = existing.visible ?? true,
    // What it is suffering from, as a plain string: one of the 5e conditions,
    // or whatever somebody typed for one this list doesn't name. Not checked
    // against that list, because half of it would refuse the custom ones - the
    // length cap below is the only thing worth enforcing on a free label.
    // Empty is Normal, which is why "never asked" and "fine" are one state.
    status = existing.status ?? '',
    // Whether that condition is written on the board, which is asked and
    // answered separately from the name beside it - see showNameplate.
    showStatus = existing.showStatus ?? false,
    // What the tooltip reads out. Everyone sees initiative; the hit points are
    // the DM's business, and the client only shows them to them.
    initiative = existing.initiative ?? null,
    // The two halves of that total, kept because the total alone can't settle a
    // tie: two creatures on 25 are separated by who had the bigger modifier,
    // which is a fact about the creature rather than about the roll. Optional -
    // a token whose initiative was typed in as a bare number has neither.
    initiativeDie = existing.initiativeDie ?? null,
    initiativeMod = existing.initiativeMod ?? null,
    maxHp = existing.maxHp ?? null,
    hp = existing.hp ?? null,
    tempHp = existing.tempHp ?? null,
    /**
     * What this creature can do to somebody, as a list of its own.
     *
     * The token's, not the sheet's, even when the two are linked. A figure
     * holding a character shows that character's attacks as well - the browser
     * reads them off the sheet and prints both lists - but the two are never
     * merged and neither is written from the other. A goblin gets a bite
     * without anybody writing it a character sheet, and a hobgoblin captain
     * borrowing the party wizard's sheet for one fight does not get to add
     * "flaming greatsword" to that wizard's record on the way past.
     */
    attacks = existing.attacks ?? [],
    x = existing.x ?? 0,
    y = existing.y ?? 0,
    size = existing.size ?? 1,
    ownerId = existing.ownerId ?? null,
  } = body;
  /**
   * Which character this token is, taken from the stored token and never from
   * the body - the same rule `access` follows on a sheet, for the same reason.
   *
   * Coupling has a route of its own (PUT /tokens/:tokenId/sheet) because it is
   * not one field: it has to release whatever else held that sheet, check that
   * the caller may edit it, and copy the character's numbers across. A `sheetId`
   * accepted here would do none of those, and would quietly leave two tokens
   * claiming one character - which is the one thing the relation promises can't
   * happen.
   */
  const sheetId = existing.sheetId ?? null;
  /**
   * Where this token was copied from, and which copy it is.
   *
   * Read off the stored token and never off the body, for the same reason
   * `sheetId` above is: lineage is decided once, by the paste that created the
   * token (see POST /:id/tokens/paste), and a client that could assert it could
   * claim to be the third copy of somebody else's dragon. Carried through every
   * ordinary edit so that renaming a copy does not quietly make it an original.
   */
  const copyOf = existing.copyOf ?? null;
  const copyIndex = existing.copyIndex ?? null;
  return {
    label: String(label).slice(0, 60),
    showNameplate: showNameplate === true,
    // Anything but an explicit false is visible: the switch is a promise about
    // who *cannot* see the token, and a malformed value must never be what
    // quietly takes a monster off the players' screens or puts it on.
    visible: visible !== false,
    status: String(status).slice(0, 40),
    showStatus: showStatus === true,
    color: hexOr(color, '#58a6ff'),
    borderColor: borderColor === null ? null : hexOr(borderColor, null),
    imageUrl: String(imageUrl).slice(0, 500),
    // Wide enough for a d20 plus any modifier a table can produce, and for the
    // dexterity contest that follows a tie.
    ...rolledInitiative(initiative, initiativeDie, initiativeMod),
    ...hitPoints(maxHp, hp, tempHp),
    // The sheet's own reading of the same shape, minus the picture: see
    // pickAttacks in sheetSchema.js.
    attacks: pickAttacks(attacks, { media: false }),
    x: num(x, 0),
    y: num(y, 0),
    size: clamp(num(size, 1), 0.5, 10),
    ownerId: ownerId ? String(ownerId) : null,
    /**
     * How far this creature can see, in cells, or null for "not said".
     *
     * On the token rather than on the scene because sight belongs to the
     * creature: bench a character with darkvision, place it on another map, and
     * it still has darkvision. Written and read in whatever unit the scene is
     * set to; the conversion happens in the browser, so what is stored is one
     * number that means the same thing on every map. See fog.js.
     */
    ...sightOf(body, existing),
    sheetId: sheetId ? String(sheetId) : null,
    copyOf: copyOf ? String(copyOf) : null,
    copyIndex: copyIndex === null ? null : num(copyIndex, null),
  };
}

/**
 * Tell the table the board changed - and tell each person only what they may
 * see.
 *
 * Per actor rather than one payload for everyone, because a scene carries its
 * tokens and some of those are the DM's alone (see canSeeToken). One broadcast
 * would hand a player the ambush in the trees the moment it was placed, which
 * is precisely the thing the switch promises it will not do.
 *
 * Not even the DM gets the record whole any more. A scene also carries its pins,
 * and a pin is private from *people* rather than from chairs - so the person
 * running the table is filtered like everybody else. See canSeePin.
 *
 * Every announcement on this router goes through here, so there is one place
 * that has to remember - a second one would eventually be the one that forgot.
 * `extra.token` is the newly placed token some actions carry beside the scene;
 * it is dropped for anybody the token is hidden from, for the same reason.
 */
function announce(req, action, record, extra = {}) {
  broadcastPerActor(req, 'scenes:changed', (actor, role) => {
    const payload = { action, record: sceneAsSeenBy(role, record, actor, req.campaign), ...extra };
    if (payload.token && !canSeeToken(role, payload.token)) delete payload.token;
    return payload;
  });
}

/**
 * Would this edit write hit points onto a character the caller may not edit?
 *
 * A token's hit points are carried to the sheet it is coupled to, so setting
 * them on the map is setting them on that sheet. Owning the figure says nothing
 * about being trusted with the character - a DM can hand somebody a token and
 * link it to a sheet they were never given - so the two permissions are asked
 * separately, exactly as the coupling route asks them.
 *
 * False when nothing is linked, when the numbers are not being changed, or when
 * the sheet is one they could have edited from the Characters tab anyway. Those
 * are all of the ordinary cases, and none of them costs a read.
 */
async function touchesForeignSheet(req, token) {
  if (!token?.sheetId) return false;
  const asked = sanitizeToken(req.body, token);
  // Temporary points among them: they reach the sheet exactly as the other two
  // do, so an edit that moves only those is still an edit to somebody's
  // character.
  if (
    asked.hp === token.hp &&
    asked.maxHp === token.maxHp &&
    asked.tempHp === token.tempHp
  ) {
    return false;
  }
  const sheet = await store.get(scoped(req.campaignId, 'sheets'), token.sheetId);
  // A link pointing at nothing grants nothing and blocks nothing.
  if (!sheet) return false;
  return !canEditSheet(req.actor, req.campaignRole, sheet);
}

/**
 * One token per cell.
 *
 * Tokens can be bigger than one cell (a size-2 ogre covers 2×2), so this is a
 * rectangle-intersection test rather than a comparison of coordinates. Every
 * check runs inside store.mutate - that is, while holding the write queue - so
 * two players cannot both be told an empty cell is theirs.
 */
function overlaps(a, b) {
  const aSize = a.size || 1;
  const bSize = b.size || 1;
  return (
    a.x < b.x + bSize && b.x < a.x + aSize && a.y < b.y + bSize && b.y < a.y + aSize
  );
}

/**
 * How close counts as "the same place" on a gridless scene.
 *
 * A fraction of a cell, and it exists because positions are floats: two tokens
 * dropped on the same spot are almost never bit-identical, so a literal `===`
 * would forbid nothing. It is a tolerance for arithmetic, not for stacking -
 * anywhere a human could see daylight between two tokens is allowed.
 */
const SAME_SPOT = 0.02;

/**
 * Is this position already taken?
 *
 * With a grid, footprints may not overlap at all - a table with squares has one
 * token per square. Without one, a token goes where you put it and the only
 * refusal left is dropping it exactly where another already stands, which would
 * hide one behind the other with no way to tell they're both there.
 */
function conflicts(scene, a, b) {
  if (scene.gridOn === false) {
    return Math.abs(a.x - b.x) < SAME_SPOT && Math.abs(a.y - b.y) < SAME_SPOT;
  }
  return overlaps(a, b);
}

// The token standing where `candidate` wants to be, if any.
function blockerFor(scene, candidate, ignoreId) {
  return (
    (scene.tokens || []).find((t) => t.id !== ignoreId && conflicts(scene, t, candidate)) || null
  );
}

// Cell counts are derived from the map size, exactly as the client derives them.
function gridOf(scene) {
  const g = scene.gridSize || 70;
  return {
    cols: Math.max(1, Math.floor((scene.width || 1200) / g)),
    rows: Math.max(1, Math.floor((scene.height || 840) / g)),
  };
}

// First cell a token of this size fits in, scanning row by row. Lets the GM add
// several tokens in a row without each one landing on the last.
function firstFreeCell(scene, size, ignoreId) {
  const { cols, rows } = gridOf(scene);
  const span = Math.max(1, Math.ceil(size || 1));
  // A gridless scene has no cells to step through, and needs none: the only
  // thing in the way is an exact overlap, which any nudge clears.
  const step = scene.gridOn === false ? 0.5 : 1;
  for (let y = 0; y + span <= Math.max(rows, span); y += step) {
    for (let x = 0; x + span <= Math.max(cols, span); x += step) {
      if (!blockerFor(scene, { x, y, size }, ignoreId)) return { x, y };
    }
  }
  return null;
}

/**
 * Refuse a move onto an occupied square, and say what is in the way.
 *
 * Named, because "the ogre is already there" is a better refusal than "no" -
 * except when the thing in the way is one the DM has hidden. Then the square is
 * still taken, and saying so is unavoidable: two tokens in one square would be
 * a board that lies about itself, and the moment the monster was revealed they
 * would be standing inside each other. What *is* avoidable is naming it, so a
 * player who walks into an invisible dragon learns that something is there and
 * nothing else about it.
 */
function refuseOverlap(scene, candidate, ignoreId, role, actor) {
  const blocker = blockerFor(scene, candidate, ignoreId);
  if (!blocker) return;
  // The same reasoning applies twice over in the dark: a player who walks into
  // something they cannot see learns that something is there, and nothing else
  // about it. Naming it would hand back through a refusal exactly what the fog
  // is keeping out of their browser.
  const seen =
    canSeeToken(role, blocker) &&
    (role === 'dm' || !fogOn(scene) || tokensSeenThroughFog(scene, actor).includes(blocker));
  const named = seen ? blocker.label : '';
  throw new HttpError(409, `${named || 'Something'} is already there.`);
}

// Find a token or fail with the right status.
function tokenIn(scene, tokenId) {
  const token = (scene.tokens || []).find((t) => t.id === tokenId);
  if (!token) throw new HttpError(404, 'Token not found');
  return token;
}

// ---- Scenes ----

// Both reads answer with the board as this person may see it: a token the DM
// has hidden is not sent, rather than sent and left out of the drawing, and
// neither is a pin they were not given. See canSeeToken and canSeePin - a
// monster the browser was told about is a monster anybody can find in the dev
// tools, and so is somebody else's secret.
router.get('/', async (req, res, next) => {
  try {
    const scenes = await store.list(scenesOf(req));
    res.json(
      scenes.map((scene) => sceneAsSeenBy(req.campaignRole, scene, req.actor, req.campaign))
    );
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const scene = await store.get(scenesOf(req), req.params.id);
    if (!scene) return res.status(404).json({ error: 'Not found' });
    res.json(sceneAsSeenBy(req.campaignRole, scene, req.actor, req.campaign));
  } catch (err) {
    next(err);
  }
});

router.post('/', requireDm, async (req, res, next) => {
  try {
    const record = await store.create(scenesOf(req), { ...sanitizeScene(req.body), tokens: [] });
    announce(req, 'create', record);
    res.status(201).json(record);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requireDm, async (req, res, next) => {
  try {
    // Merge scene fields only - tokens have their own endpoints, so a stale
    // client PUT can't wipe the board.
    const record = await store.update(scenesOf(req), req.params.id, sanitizeScene(req.body));
    if (!record) return res.status(404).json({ error: 'Not found' });
    announce(req, 'update', record);
    res.json(record);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireDm, async (req, res, next) => {
  try {
    const ok = await store.remove(scenesOf(req), req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    announce(req, 'delete', { id: req.params.id });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---- Tokens ----

router.post('/:id/tokens', requireDm, async (req, res, next) => {
  try {
    const wanted = {
      id: crypto.randomUUID(),
      ...sanitizeToken(req.body),
      // Who made it, which is a different question from who owns it - see
      // routes/campaignTokens.js, where it decides whether a player may make
      // another. Read off the session, never the request.
      createdBy: req.actor?.userId || null,
    };
    const scene = await store.mutate(scenesOf(req), req.params.id, (current) => {
      let token = wanted;
      // Asking for an occupied cell isn't an error when adding - slide the new
      // token to the first free one instead. Tokens are created where the DM
      // right-clicked, and "on top of that one" is a near miss rather than a
      // mistake worth refusing.
      if (blockerFor(current, token, null)) {
        const free = firstFreeCell(current, token.size, null);
        if (!free) throw new HttpError(409, 'No free cell left on this scene.');
        token = { ...token, ...free };
      }
      return { ...current, tokens: [...(current.tokens || []), token] };
    });
    if (!scene) return res.status(404).json({ error: 'Not found' });
    const placed = scene.tokens.find((t) => t.id === wanted.id);
    announce(req, 'token:add', scene, { token: placed });
    res.status(201).json(placed);
  } catch (err) {
    next(err);
  }
});

/**
 * Full token edit - the DM on any token, an owner on their own.
 *
 * The same reach the Tokens tab already gives an owner, offered where they are
 * actually playing: a player who may rename their figure from a list two tabs
 * away had no reason to be sent there to do it.
 *
 * Two things stay the DM's inside that edit, and both are checked here rather
 * than trusted to the form that draws them:
 *
 *   who it belongs to  giving a token away is the act that takes something
 *                      from somebody else. An owner sending an `ownerId` gets
 *                      the one already stored.
 *   somebody else's    hit points travel to the linked character sheet, so
 *   character's wounds writing them is writing that sheet. Where the caller
 *                      could not edit that sheet directly, this refuses rather
 *                      than quietly dropping the numbers.
 */
router.put('/:id/tokens/:tokenId', requireUser, async (req, res, next) => {
  try {
    const before = tokenIn(await store.get(scenesOf(req), req.params.id) || {}, req.params.tokenId);
    if (!before) return res.status(404).json({ error: 'Not found' });
    const dm = isDm(req.campaign, req.actor);
    if (!canMoveToken(req.actor, req.campaignRole, before)) {
      throw new HttpError(403, 'You can only edit your own token.');
    }
    if (!dm && (await touchesForeignSheet(req, before))) {
      throw new HttpError(
        403,
        "Those hit points belong to a character you can't edit. Ask your DM."
      );
    }

    const scene = await store.mutate(scenesOf(req), req.params.id, (current) => {
      const existing = tokenIn(current, req.params.tokenId);
      const asked = sanitizeToken(req.body, existing);
      // Two fields an owner's edit cannot carry however the request was built.
      // Handing a token to somebody takes it from them; hiding one decides what
      // the rest of the table can see. Both are the DM's, and both are put back
      // here rather than trusted to the form that drew them.
      const updated = {
        ...existing,
        ...asked,
        ...(dm
          ? {}
          : {
            ownerId: existing.ownerId ?? null,
            visible: existing.visible !== false,
            // How far a creature can see decides what the rest of the table is
            // allowed to know about the board. Its owner does not get to widen
            // it by editing their own token.
            visionClear: existing.visionClear ?? null,
            visionDim: existing.visionDim ?? null,
          }),
      };
      // Growing a token can push it into a neighbour just as moving it can.
      refuseOverlap(current, updated, updated.id, req.campaignRole, req.actor);
      return {
        ...current,
        tokens: current.tokens.map((t) => (t.id === updated.id ? updated : t)),
      };
    });
    if (!scene) return res.status(404).json({ error: 'Not found' });
    const updated = scene.tokens.find((t) => t.id === req.params.tokenId);
    // Damage applied on the map is damage the character took. Hit points are
    // the one thing here that means the same at both ends, so they travel back
    // to the sheet - the modifier does not, since on the sheet it is derived
    // from dexterity and has no single number to write to.
    const moved = await sheetLink.pushTokenToSheet(req.campaignId, updated);
    // And the table is told, per person: an open sheet window should show the
    // wound as it lands rather than whenever its reader next reloads. Per actor
    // because who may see a sheet varies, and this is the same record the
    // sheets router would be broadcasting.
    //
    // A knock-on change, so it carries no origin. Whoever applied the damage
    // edited a *token*; the sheet moving with it is a record they never wrote
    // and never applied locally, and with their own id on it they were the one
    // person at the table who threw it away - the DM hitting a goblin while
    // reading its sheet saw the old hit points there until they reloaded.
    if (moved) {
      broadcastPerActor(
        req,
        'sheets:changed',
        (actor, role) =>
          canViewSheet(actor, role, moved.sheet)
            ? { action: 'update', record: moved.sheet }
            : { action: 'delete', record: { id: moved.sheet.id } },
        { knockOn: true }
      );
    }

    /**
     * The same creature, on the other maps it is standing on.
     *
     * Everything but where it stands: a token on the town square and in the
     * tavern is one innkeeper, so renaming or wounding it here has to reach
     * both. Done after the write above rather than inside it, because each
     * scene is its own record and its own transaction.
     */
    const alsoHere = await patchEverywhere(req.campaignId, req.params.tokenId, updated, {
      exceptSceneId: req.params.id,
    });

    /**
     * And the character's *other figures* - different tokens holding the same
     * sheet - which move with it for a different reason.
     *
     * A wound lands on all of them. Announcing this scene from the copy above
     * would be announcing it as it was *before* a sibling on the same map was
     * updated - so where that happened, it is read again.
     */
    const alsoMoved = [...new Set([...(moved?.scenes || []), ...alsoHere])];
    const here = alsoMoved.includes(req.params.id)
      ? (await store.get(scenesOf(req), req.params.id)) || scene
      : scene;
    announce(req, 'token:update', here);
    for (const sceneId of alsoMoved) {
      if (sceneId === req.params.id) continue;
      const other = await store.get(scenesOf(req), sceneId);
      if (other) announce(req, 'token:update', other);
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

/**
 * Initiative - the second write a player is allowed to make, on their own
 * token.
 *
 * Its own route rather than a hole in the edit above, because the difference
 * matters: what a creature rolled is the player's to say, and what it looks
 * like, how big it is and who it belongs to are the DM's. A carve-out in the
 * full edit would have to be maintained field by field forever; a route that
 * can only reach three numbers cannot grow one by accident.
 */
router.put('/:id/tokens/:tokenId/initiative', async (req, res, next) => {
  try {
    /**
     * A linked token's modifier is its sheet's, whatever the request says.
     *
     * Read before the write, because the mutate below is synchronous and this
     * needs a second record. What a creature *rolled* is still the player's to
     * say - only the modifier is decided elsewhere, and it is decided elsewhere
     * because on the sheet it is dexterity plus a bonus rather than a number
     * anybody typed.
     */
    const before = await store.get(scenesOf(req), req.params.id);
    const linkedTo = (before?.tokens || []).find((t) => t.id === req.params.tokenId)?.sheetId;
    let sheetMod = null;
    if (linkedTo) {
      const sheet = await store.get(scoped(req.campaignId, 'sheets'), linkedTo);
      if (sheet) sheetMod = sheetLink.initiativeModOf(sheet);
    }

    const scene = await store.mutate(scenesOf(req), req.params.id, (current) => {
      const existing = tokenIn(current, req.params.tokenId);
      if (!canMoveToken(req.actor, req.campaignRole, existing)) {
        throw new HttpError(403, 'You can only set initiative on your own token.');
      }
      // Through the same derivation the full edit uses, so a die and a modifier
      // still decide the total and a lone half still falls back to a bare one.
      const rolled = rolledInitiative(
        req.body?.initiative,
        req.body?.initiativeDie,
        sheetMod === null ? req.body?.initiativeMod : sheetMod
      );
      return {
        ...current,
        tokens: current.tokens.map((t) => (t.id === existing.id ? { ...t, ...rolled } : t)),
      };
    });
    if (!scene) return res.status(404).json({ error: 'Not found' });
    announce(req, 'token:update', scene);
    res.json(scene.tokens.find((t) => t.id === req.params.tokenId));
  } catch (err) {
    next(err);
  }
});

// Move - the one write a player is allowed to make. Position only: a player
// can't repaint or rename a token by POSTing extra fields here.
router.put('/:id/tokens/:tokenId/position', async (req, res, next) => {
  try {
    const scene = await store.mutate(scenesOf(req), req.params.id, (current) => {
      const existing = tokenIn(current, req.params.tokenId);
      if (!canMoveToken(req.actor, req.campaignRole, existing)) {
        throw new HttpError(403, 'You can only move your own token.');
      }
      const moved = { ...existing, x: num(req.body?.x, existing.x), y: num(req.body?.y, existing.y) };
      refuseOverlap(current, moved, moved.id, req.campaignRole, req.actor);
      return {
        ...current,
        tokens: current.tokens.map((t) => (t.id === moved.id ? moved : t)),
      };
    });
    if (!scene) return res.status(404).json({ error: 'Not found' });
    announce(req, 'token:move', scene);
    res.json(scene.tokens.find((t) => t.id === req.params.tokenId));
  } catch (err) {
    next(err);
  }
});

// ---- The bench ----

/**
 * Off the table, but not gone.
 *
 * A token is *standing* on however many scenes it has been placed on, and it is
 * on the bench when it is standing on none of them. One creature, one id, one
 * set of everything it is - and a position per map, because where it stands is
 * the only fact about it that is different from one map to the next.
 *
 * That is a change from what this used to promise, which was one place at a
 * time. The reason is prep: the innkeeper belongs on the town map *and* in the
 * tavern, and a recurring NPC that had to be taken off one map to appear on the
 * other was a token you ended up copying, which left the table with two of them
 * to keep in step by hand. Every write about a token now reaches all of its
 * placements (see fanOut), so there is still exactly one answer to what a
 * creature is called, what it looks like and how hurt it is.
 *
 * The bench is campaign-level on purpose. A token taken off its last map has to
 * be placeable on a *different* one, and it has to survive the deletion of the
 * scene it came from, which a scene-shaped home could not promise.
 *
 * Who may move a token between the two is exactly who may move it about on the
 * map: the DM, or the player it belongs to. Taking your own character off the
 * board and bringing it back next session is the same authority as walking it
 * across the room.
 */
const benchOf = (req) => scoped(req.campaignId, 'bench');

router.put('/:id/tokens/:tokenId/bench', async (req, res, next) => {
  try {
    let taken = null;
    const scene = await store.mutate(scenesOf(req), req.params.id, (current) => {
      const existing = tokenIn(current, req.params.tokenId);
      if (!canMoveToken(req.actor, req.campaignRole, existing)) {
        throw new HttpError(403, 'You can only take your own token off the table.');
      }
      taken = existing;
      return {
        ...current,
        tokens: current.tokens.filter((t) => t.id !== existing.id),
        // A token that was taking its turn isn't taking it any more. Cleared
        // rather than advanced: whose turn it is next is a decision about the
        // fight, and the DM has a button for it.
        turnTokenId: current.turnTokenId === existing.id ? null : current.turnTokenId,
      };
    });
    if (!scene) return res.status(404).json({ error: 'Not found' });

    // Position goes. It described a square on a map this token is no longer on,
    // and keeping it would mean a token that remembers where it used to stand
    // on a scene that may not exist by the time it comes back.
    const { x, y, ...rest } = taken;
    /**
     * The bench is where a token goes when it is standing nowhere.
     *
     * A creature that is also on two other maps has not left the table, so it
     * gets no bench entry - one would put it in the "waiting to be placed" list
     * while it is plainly in play, and placing it from there would be placing
     * something that is already out.
     */
    const { placements } = await placementsOf(req.campaignId, taken.id);
    const stillOut = placements.length > 0;
    if (!stillOut) {
      await store.put(benchOf(req), { ...rest, benchedAt: new Date().toISOString() });
    }
    announce(req, 'token:benched', scene);
    res.json({ benched: rest, stillOn: placements.map((p) => p.sceneId) });
  } catch (err) {
    next(err);
  }
});

/**
 * Onto this table, at the spot that was right-clicked.
 *
 * From the bench, or from another map it is already standing on: the same
 * creature can be on the town square and in the tavern at once, and placing it
 * a second time is how it gets there. What arrives is the same token, id and
 * all - not a copy - so renaming it or wounding it anywhere reaches every map
 * it is on. Copying is the other thing, and it has its own route below.
 *
 * The one refusal is placing it where it already is. A second figure of one
 * creature on one map would be two things the board cannot tell apart and the
 * app cannot address separately, which is exactly what a copy is for.
 *
 * Takes the same courtesy `POST /tokens` does with an occupied cell: slide to
 * the first free one rather than refuse. Somebody placing a character is
 * pointing at a room, not at a square.
 */
router.post('/:id/tokens/from-bench', async (req, res, next) => {
  try {
    const tokenId = String(req.body?.tokenId || '');
    const { bench, placements } = await placementsOf(req.campaignId, tokenId);
    const source = bench || placements[0];
    if (!source) return res.status(404).json({ error: 'No such token in this campaign.' });
    if (!canMoveToken(req.actor, req.campaignRole, source.token)) {
      throw new HttpError(403, 'You can only place a token that belongs to you.');
    }
    if (placements.some((p) => p.sceneId === req.params.id)) {
      throw new HttpError(
        409,
        `${source.token.label || 'That token'} is already standing on this scene. Copy it instead to have two.`
      );
    }

    const wanted = {
      ...source.token,
      x: num(req.body?.x, 0),
      y: num(req.body?.y, 0),
    };
    delete wanted.benchedAt;

    const scene = await store.mutate(scenesOf(req), req.params.id, (current) => {
      let token = wanted;
      if (blockerFor(current, token, null)) {
        const free = firstFreeCell(current, token.size, null);
        if (!free) throw new HttpError(409, 'No free cell left on this scene.');
        token = { ...token, ...free };
      }
      return { ...current, tokens: [...(current.tokens || []), token] };
    });
    if (!scene) return res.status(404).json({ error: 'Not found' });

    // Only once it is standing somewhere, and only if it was waiting: a token
    // taken from another map was never on the bench to leave. A crash between
    // the two leaves a token on the bench and on the table, which is a
    // duplicate you can delete - the other order loses it entirely.
    if (bench) await store.remove(benchOf(req), tokenId);
    const placed = scene.tokens.find((t) => t.id === tokenId);
    announce(req, 'token:add', scene, { token: placed });
    res.status(201).json(placed);
  } catch (err) {
    next(err);
  }
});

/**
 * Paste a copy of a token onto the square that was right-clicked.
 *
 * What arrives is the same creature again: the same face, size, colour,
 * condition, hit points and initiative, belonging to the same person. Three
 * things are deliberately not the same.
 *
 *   its id        a new one, minted here. Two tokens with one id would be one
 *                 token that is in two places, which nothing downstream could
 *                 make sense of.
 *   its name      the original's, with the number of copies in brackets - so a
 *                 board with four ogres on it can be talked about out loud.
 *   its character The sheet link is **not** copied. A sheet belongs to one
 *                 token (see sheetLink.js): coupling is what makes a wound on
 *                 the map a wound on the character, and two figures writing to
 *                 one sheet is the single thing that relation promises cannot
 *                 happen. A copy is another figure, not another character, and
 *                 whoever wants it linked can link it.
 *
 * Who may: exactly who may move the token being copied. Copying your own
 * familiar is your business, the DM's board is theirs, and nobody gets a way to
 * duplicate somebody else's figure.
 *
 * The source is looked up across the whole campaign rather than in this scene,
 * because copy and paste are two acts with as much time between them as
 * somebody likes: the token may have been benched, or the map changed, in
 * between. Pasting from another scene is not an error either - the copy is a
 * new token, and where it came from is only a name and a number.
 */
router.post('/:id/tokens/paste', requireUser, async (req, res, next) => {
  try {
    const found = await locateToken(req.campaignId, String(req.body?.tokenId || ''));
    if (!found) return res.status(404).json({ error: 'That token no longer exists.' });
    if (!canMoveToken(req.actor, req.campaignRole, found.token)) {
      throw new HttpError(403, 'You can only copy a token that belongs to you.');
    }

    const source = found.token;
    const root = rootIdOf(source);
    // Counted now, at the moment of pasting, and counting the one about to
    // exist: the first copy of an ogre is "Ogre (Copy 1)".
    const number = (await countCopies(req.campaignId, root)) + 1;

    const wanted = {
      // Everything the token is, normalised the same way an edit would be. The
      // empty second argument is what drops the two fields sanitizeToken reads
      // only from storage - the sheet link, which a copy must not inherit, and
      // the lineage, which is set below rather than carried across.
      ...sanitizeToken(source, {}),
      id: crypto.randomUUID(),
      label: copyLabelFor(source.label, number),
      // Whose hand made this one. Ownership came across with the rest above: a
      // copy of a player's familiar is still that player's.
      createdBy: req.actor?.userId || null,
      copyOf: root,
      copyIndex: number,
      x: num(req.body?.x, 0),
      y: num(req.body?.y, 0),
    };

    const scene = await store.mutate(scenesOf(req), req.params.id, (current) => {
      let token = wanted;
      // The same courtesy adding and placing take: a copy dropped on an
      // occupied square slides to the first free one. Pasting beside the thing
      // you copied is the normal case, and "on top of it" is a near miss.
      if (blockerFor(current, token, null)) {
        const free = firstFreeCell(current, token.size, null);
        if (!free) throw new HttpError(409, 'No free cell left on this scene.');
        token = { ...token, ...free };
      }
      return { ...current, tokens: [...(current.tokens || []), token] };
    });
    if (!scene) return res.status(404).json({ error: 'Not found' });

    const placed = scene.tokens.find((t) => t.id === wanted.id);
    announce(req, 'token:add', scene, { token: placed });
    res.status(201).json(placed);
  } catch (err) {
    next(err);
  }
});

// ---- Shapes ----

/**
 * The drawing layer: the fireball's circle, the dragon's cone, a rectangle
 * around the room nobody has opened yet.
 *
 * Measured in *cells*, like tokens and for the same reason - a shape means "the
 * six squares by the door", not "these pixels of this picture", so it keeps its
 * meaning when the grid is retuned and rides the grid's offset with everything
 * else standing on the board.
 *
 * Anyone playing may draw, and everyone at the table sees what's drawn - scenes
 * go out whole to every member. A player marking where a spell lands or where
 * they mean to run is the same kind of act as moving their own token.
 *
 * What follows from that is the ownership rule tokens already have, and it is
 * the whole of the permission model here: a shape remembers the hand that drew
 * it, that hand may change or rub out its own, and the DM may change or rub out
 * anybody's. Nobody can reach across the table at somebody else's marks.
 */
const SHAPE_KINDS = new Set(['rect', 'circle', 'cone', 'line']);

// A ceiling, not a budget. Nobody draws two hundred shapes on one map on
// purpose; something that has is a stuck pointer or a bad script, and the point
// is that it stops before the scene record does.
const MAX_SHAPES = 200;

function sanitizeShape(body = {}, existing = {}) {
  const cells = (value, fallback, lo = 0.1, hi = 200) => clamp(num(value, fallback), lo, hi);
  return {
    kind: SHAPE_KINDS.has(body.kind) ? body.kind : existing.kind || 'rect',
    // Where it sits: a rectangle's top-left corner, a circle's centre, the
    // point a cone or a line comes out of.
    x: clamp(num(body.x, existing.x ?? 0), -500, 500),
    y: clamp(num(body.y, existing.y ?? 0), -500, 500),
    w: cells(body.w, existing.w ?? 1),
    h: cells(body.h, existing.h ?? 1),
    // Radius for a circle, length for a cone or a line.
    r: cells(body.r, existing.r ?? 1),
    // Which way a cone or a line points: degrees clockwise from due east, and
    // wrapped rather than clamped, since 370° is a direction like any other.
    dir: (((num(body.dir, existing.dir ?? 0) % 360) + 360) % 360),
    // How wide a cone opens. 53° is the angle a 5e cone template cuts, which is
    // why every tabletop that has one of these defaults to it.
    angle: clamp(num(body.angle, existing.angle ?? 53), 5, 360),
    thickness: cells(body.thickness, existing.thickness ?? 1, 0.1, 20),
    fill: hexOr(body.fill ?? existing.fill, '#58a6ff'),
    stroke: hexOr(body.stroke ?? existing.stroke, '#9fb4ff'),
    opacity: clamp(Math.round(num(body.opacity, existing.opacity ?? 35)), 5, 100),
    strokeWidth: clamp(Math.round(num(body.strokeWidth, existing.strokeWidth ?? 2)), 0, 12),
    label: String(body.label ?? existing.label ?? '').slice(0, 40),
  };
}

/**
 * A token's two sight distances, kept as they are unless the caller says
 * otherwise.
 *
 * `undefined` means the request was not about sight at all - most token edits
 * aren't - and leaves what is stored alone. `null` is a field the DM has
 * cleared, which is a real answer: it means "no limit on this band".
 */
function sightOf(body = {}, existing = {}) {
  const field = (key) => {
    if (!(key in body)) return existing[key] ?? null;
    const value = body[key];
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? clamp(n, 0, 500) : null;
  };
  return { visionClear: field('visionClear'), visionDim: field('visionDim') };
}

/**
 * Yours to change if you drew it; the DM's to change whoever drew it.
 *
 * Deliberately the same shape as canMoveToken, because it is the same idea
 * about a different object: a mark on the map belongs to the person who made
 * it, and the table's owner overrules that as they overrule everything else on
 * their own board.
 *
 * A shape with no owner at all - one that arrived through an import, where the
 * ids of another server's people mean nothing - is the DM's alone. That is the
 * safe reading: better a mark only the DM can clear than one anybody can.
 */
function canEditShape(actor, role, shape) {
  if (!actor || !shape || !role) return false;
  if (role === 'dm') return true;
  return Boolean(shape.ownerId) && shape.ownerId === actor.userId;
}

// Drawing is for the people at the table. A spectator reads the board.
function requireDrawer(req, res, next) {
  if (req.campaignRole === 'dm' || req.campaignRole === 'player') return next();
  return res.status(403).json({ error: 'Only the people playing at this table can draw on it.' });
}

function shapeIn(scene, shapeId) {
  const shape = (scene.shapes || []).find((s) => s.id === shapeId);
  if (!shape) throw new HttpError(404, 'Shape not found');
  return shape;
}

router.post('/:id/shapes', requireDrawer, async (req, res, next) => {
  try {
    const shape = {
      id: crypto.randomUUID(),
      ...sanitizeShape(req.body),
      // Read off the session, never off the request: who drew a shape decides
      // who may change it, so it isn't a thing the drawer gets to claim.
      ownerId: req.actor?.userId || null,
    };
    const scene = await store.mutate(scenesOf(req), req.params.id, (current) => {
      const shapes = current.shapes || [];
      if (shapes.length >= MAX_SHAPES) {
        throw new HttpError(409, 'This scene is holding as many shapes as it can. Clear a few first.');
      }
      return { ...current, shapes: [...shapes, shape] };
    });
    if (!scene) return res.status(404).json({ error: 'Not found' });
    announce(req, 'shape:add', scene);
    res.status(201).json(shape);
  } catch (err) {
    next(err);
  }
});

router.put('/:id/shapes/:shapeId', requireDrawer, async (req, res, next) => {
  try {
    const scene = await store.mutate(scenesOf(req), req.params.id, (current) => {
      const existing = shapeIn(current, req.params.shapeId);
      if (!canEditShape(req.actor, req.campaignRole, existing)) {
        throw new HttpError(403, 'You can only change a shape you drew.');
      }
      // The id and the hand that drew it are not fields of the edit.
      const updated = {
        ...existing,
        ...sanitizeShape(req.body, existing),
        id: existing.id,
        ownerId: existing.ownerId ?? null,
      };
      return { ...current, shapes: current.shapes.map((s) => (s.id === updated.id ? updated : s)) };
    });
    if (!scene) return res.status(404).json({ error: 'Not found' });
    announce(req, 'shape:update', scene);
    res.json(scene.shapes.find((s) => s.id === req.params.shapeId));
  } catch (err) {
    next(err);
  }
});

/**
 * Clear the board - of everything the caller may take off it.
 *
 * One transaction rather than a delete per shape: the table would otherwise
 * watch the map empty a shape at a time, and a request that failed halfway
 * would leave a board nobody asked for. The same ownership rule as the single
 * delete decides what goes, so a player clears their own drawings and the DM
 * clears the lot.
 *
 * Answers with what it actually removed, which is what lets the drawer put it
 * all back again.
 */
router.delete('/:id/shapes', requireDrawer, async (req, res, next) => {
  try {
    let removed = [];
    const scene = await store.mutate(scenesOf(req), req.params.id, (current) => {
      const shapes = current.shapes || [];
      // Only the ones this hand may take off: everything for the DM, your own
      // for everyone else.
      removed = shapes.filter((s) => canEditShape(req.actor, req.campaignRole, s));
      if (!removed.length) return current;
      const going = new Set(removed.map((s) => s.id));
      return { ...current, shapes: shapes.filter((s) => !going.has(s.id)) };
    });
    if (!scene) return res.status(404).json({ error: 'Not found' });
    if (removed.length) announce(req, 'shape:clear', scene);
    res.json({ removed });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/shapes/:shapeId', requireDrawer, async (req, res, next) => {
  try {
    const scene = await store.mutate(scenesOf(req), req.params.id, (current) => {
      const existing = shapeIn(current, req.params.shapeId);
      if (!canEditShape(req.actor, req.campaignRole, existing)) {
        throw new HttpError(403, 'You can only rub out a shape you drew.');
      }
      return { ...current, shapes: current.shapes.filter((s) => s.id !== existing.id) };
    });
    if (!scene) return res.status(404).json({ error: 'Not found' });
    announce(req, 'shape:delete', scene);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---- Pins ----

/**
 * Pins: a note stuck in the map at a spot, with a title on it.
 *
 * Where a shape marks out ground, a pin holds *writing* - what the innkeeper is
 * called, what the party worked out about the well, the text of the plaque on
 * the statue. So it is measured in map pixels rather than cells, and it ignores
 * the grid entirely: a pin is stuck in the picture, at the exact point somebody
 * clicked, and retuning the grid must not slide it off the doorway it names.
 *
 * Its content is a rich-text document rather than a string - links and pictures
 * are half of what anybody wants to put in one - and that document arrives from
 * a browser, which is why sanitizeDoc below rebuilds it rather than trusting it.
 *
 * Who may read one is canSeePin; who may change one is canEditPin. Both live in
 * campaigns.js beside the token rules, because the filtering happens on the way
 * out of every scene read and not only on the routes here.
 */
const PIN_VISIBILITIES = new Set(['private', 'shared', 'public']);

// A ceiling, not a budget, exactly like MAX_SHAPES: a scene with a hundred pins
// on it is a scene nobody can read anyway.
const MAX_PINS = 100;
const MAX_SHARED_WITH = 100; // a table, not a mailing list
const MAX_PIN_TITLE = 80;
// The most a pin's document may weigh once rebuilt. Generous for prose - it is
// several thousand words - and nowhere near enough to post a picture as a data
// URL, which is deliberate: pictures are uploaded and referenced by address.
const MAX_PIN_CONTENT = 60000;
// And how many nodes it may be made of, which is the other way a document can
// be enormous. Checked while walking, so a pathological doc stops being copied
// rather than being copied and then measured.
const MAX_PIN_NODES = 800;

/**
 * The document model, written out as the list this server keeps.
 *
 * These are the nodes and marks the pin editor can produce (Tiptap's StarterKit,
 * plus images) and each one's attributes are named rather than passed through.
 * Anything else in the incoming document is dropped: an unknown node, an unknown
 * mark, an attribute nobody asked for. That is what makes storing a document
 * somebody else's browser will render safe to do - the shape that comes out of
 * here is one this file wrote, not one a client sent.
 */
const PIN_NODES = new Map([
  ['doc', []],
  ['paragraph', []],
  ['text', []],
  ['hardBreak', []],
  ['horizontalRule', []],
  ['blockquote', []],
  ['bulletList', []],
  ['orderedList', ['start']],
  ['listItem', []],
  ['heading', ['level']],
  ['codeBlock', ['language']],
  ['image', ['src', 'alt', 'title']],
]);

const PIN_MARKS = new Map([
  ['bold', []],
  ['italic', []],
  ['underline', []],
  ['strike', []],
  ['code', []],
  ['link', ['href', 'target', 'rel']],
]);

/**
 * An address a pin may point at, or '' for one it may not.
 *
 * Three kinds get through: http and https, mailto, and a path on this server -
 * which is where an uploaded picture lives. Everything else is refused, and the
 * one that matters is `javascript:`, since a link in a document that half the
 * table will click is exactly where somebody would put one.
 *
 * A protocol-relative `//host/path` is refused with it: it reads like a path and
 * behaves like an absolute address to somewhere else.
 */
function safeUrl(value) {
  const url = String(value ?? '').trim();
  if (!url || url.length > 2000) return '';
  if (url.startsWith('//')) return '';
  if (url.startsWith('/')) return url;
  return /^(https?:|mailto:)/i.test(url) ? url : '';
}

/**
 * Rebuild a pin's document, keeping only what is in the lists above.
 *
 * Rebuilt rather than checked, because a check has to be exhaustive to be worth
 * anything and a rebuild cannot let through what it does not copy. Nodes it
 * does not know are dropped whole; a link with an address it will not have
 * loses the link and keeps the words; an image with nowhere to point is not an
 * image at all and goes.
 *
 * `budget` is shared across the whole walk rather than counted per level, so
 * depth cannot be traded for breadth.
 */
function sanitizeNode(node, budget) {
  if (!node || typeof node !== 'object') return null;
  const attrNames = PIN_NODES.get(node.type);
  if (!attrNames) return null;
  if (budget.left <= 0) return null;
  budget.left -= 1;

  const out = { type: node.type };

  if (node.type === 'text') {
    const text = String(node.text ?? '');
    if (!text) return null;
    out.text = text;
  }

  const attrs = {};
  for (const name of attrNames) {
    const value = node.attrs?.[name];
    if (value === undefined || value === null) continue;
    if (name === 'src') {
      const src = safeUrl(value);
      if (!src) return null; // an image pointing nowhere is not an image
      attrs.src = src;
    } else if (name === 'level') {
      attrs.level = clamp(Math.round(num(value, 1)), 1, 6);
    } else if (name === 'start') {
      attrs.start = clamp(Math.round(num(value, 1)), 1, 9999);
    } else {
      attrs[name] = String(value).slice(0, 500);
    }
  }
  if (Object.keys(attrs).length) out.attrs = attrs;

  const marks = [];
  for (const mark of Array.isArray(node.marks) ? node.marks : []) {
    const markAttrs = PIN_MARKS.get(mark?.type);
    if (!markAttrs) continue;
    const kept = { type: mark.type };
    if (mark.type === 'link') {
      const href = safeUrl(mark.attrs?.href);
      if (!href) continue; // the words stay; the link doesn't
      // Opened in a tab of its own, and told not to hand this page over with
      // it. Set here rather than taken from the client so it is true of every
      // link in every pin, including ones written by an older browser.
      kept.attrs = { href, target: '_blank', rel: 'noopener noreferrer nofollow' };
    }
    marks.push(kept);
  }
  if (marks.length) out.marks = marks;

  const content = [];
  for (const child of Array.isArray(node.content) ? node.content : []) {
    const kept = sanitizeNode(child, budget);
    if (kept) content.push(kept);
  }
  if (content.length) out.content = content;

  return out;
}

/** An empty document: what a pin with nothing written in it holds. */
const emptyDoc = () => ({ type: 'doc', content: [{ type: 'paragraph' }] });

function sanitizeDoc(value) {
  const doc = sanitizeNode(value, { left: MAX_PIN_NODES });
  if (!doc || doc.type !== 'doc' || !doc.content?.length) return emptyDoc();
  if (JSON.stringify(doc).length > MAX_PIN_CONTENT) {
    throw new HttpError(413, 'That pin is holding more than a pin can hold. Try shortening it.');
  }
  return doc;
}

/** Ids of people a pin is shared with - deduped, and shaped like our ids. */
function pickSharedWith(source) {
  if (!Array.isArray(source)) return [];
  const out = [];
  for (const raw of source.slice(0, MAX_SHARED_WITH)) {
    const id = String(raw ?? '');
    // Not checked against the campaign's members, for the reason notes.js gives
    // at the same spot: every route here runs behind attachCampaign, so a
    // leftover id is dead weight rather than a way in - and keeping it means
    // somebody added back to the table gets their pins back.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/**
 * Everything the author of a pin decides about it.
 *
 * `sharedWith` is kept whatever the visibility says, exactly as a note's is: the
 * list is a decision about people and the visibility is a decision about whether
 * it is in force, so passing through Private must not cost somebody the names
 * they picked.
 */
function sanitizePin(body = {}, existing = {}) {
  // Map pixels, and clamped to a range no map exceeds rather than to this map's
  // own size: a scene can be given a smaller picture afterwards, and a pin that
  // was quietly rewritten to the new edge would be a pin that had moved.
  const coord = (value, fallback) => Math.round(clamp(num(value, fallback), -20000, 20000));
  return {
    title: String(body.title ?? existing.title ?? '').trim().slice(0, MAX_PIN_TITLE) || 'Pin',
    x: coord(body.x, existing.x ?? 0),
    y: coord(body.y, existing.y ?? 0),
    // The head of the pin on the map, and the paper the open one is written on.
    color: hexOr(body.color ?? existing.color, '#e5534b'),
    background: hexOr(body.background ?? existing.background, '#161b22'),
    content: sanitizeDoc(body.content ?? existing.content),
    visibility: PIN_VISIBILITIES.has(body.visibility)
      ? body.visibility
      : PIN_VISIBILITIES.has(existing.visibility)
        ? existing.visibility
        : 'private',
    sharedWith: pickSharedWith(body.sharedWith ?? existing.sharedWith),
  };
}

// Sticking a pin in the map is for the people playing, like drawing on it. A
// spectator reads the board.
function requirePinner(req, res, next) {
  if (req.campaignRole === 'dm' || req.campaignRole === 'player') return next();
  return res.status(403).json({ error: 'Only the people playing at this table can add pins.' });
}

/**
 * Find a pin - and answer 404 for one this person may not read.
 *
 * Deliberately the same answer for "no such pin" and "not yours to see": a 403
 * on a private pin would confirm that something is stuck in the map at that
 * spot, which is precisely what the setting is for.
 */
function pinIn(req, scene, pinId) {
  const pin = (scene.pins || []).find((p) => p.id === pinId);
  if (!pin || !canSeePin(req.actor, pin, req.campaign, req.campaignRole)) {
    throw new HttpError(404, 'Pin not found');
  }
  return pin;
}

function requireOwnPin(req, pin) {
  if (!canEditPin(req.actor, pin, req.campaign, req.campaignRole)) {
    throw new HttpError(403, 'Only the person who made a pin can change it.');
  }
}

router.post('/:id/pins', requirePinner, async (req, res, next) => {
  try {
    const pin = {
      id: crypto.randomUUID(),
      ...sanitizePin(req.body),
      // Read off the session, never off the request: whose pin this is decides
      // both who may edit it and who may read a private one, so it is not
      // something the caller gets to claim.
      ownerId: req.actor?.userId || null,
      createdAt: new Date().toISOString(),
    };
    const scene = await store.mutate(scenesOf(req), req.params.id, (current) => {
      const pins = current.pins || [];
      if (pins.length >= MAX_PINS) {
        throw new HttpError(409, 'This scene is holding as many pins as it can. Clear a few first.');
      }
      return { ...current, pins: [...pins, pin] };
    });
    if (!scene) return res.status(404).json({ error: 'Not found' });
    announce(req, 'pin:add', scene);
    res.status(201).json(pin);
  } catch (err) {
    next(err);
  }
});

router.put('/:id/pins/:pinId', requirePinner, async (req, res, next) => {
  try {
    let updated = null;
    const scene = await store.mutate(scenesOf(req), req.params.id, (current) => {
      const existing = pinIn(req, current, req.params.pinId);
      requireOwnPin(req, existing);
      // The id, the hand that stuck it in and when are not fields of the edit.
      updated = {
        ...existing,
        ...sanitizePin(req.body, existing),
        id: existing.id,
        ownerId: existing.ownerId ?? null,
        createdAt: existing.createdAt ?? null,
      };
      return { ...current, pins: current.pins.map((p) => (p.id === updated.id ? updated : p)) };
    });
    if (!scene) return res.status(404).json({ error: 'Not found' });
    announce(req, 'pin:update', scene);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/pins/:pinId', requirePinner, async (req, res, next) => {
  try {
    const scene = await store.mutate(scenesOf(req), req.params.id, (current) => {
      const existing = pinIn(req, current, req.params.pinId);
      requireOwnPin(req, existing);
      return { ...current, pins: current.pins.filter((p) => p.id !== existing.id) };
    });
    if (!scene) return res.status(404).json({ error: 'Not found' });
    announce(req, 'pin:delete', scene);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---- The table's scene ----

/**
 * Which scene the players are looking at.
 *
 * The DM has a picker and everybody else does not, which is the point: the
 * board is a thing the table looks at together, and a player who could wander
 * off to the map of the next dungeon would be reading the DM's prep. So one
 * scene is *the* scene, and that is the one every player's tabletop shows.
 *
 * Stored as a flag on the scene rather than as a pointer on the campaign, and
 * the trade is worth writing down: a pointer would be one field to set, but it
 * would live in a record this router does not own and would have to be kept in
 * step when a scene is deleted. The flag lives with the thing it is about and
 * disappears with it - and "exactly one" is enforced here, by clearing the
 * others in the same request.
 *
 * Nothing is broadcast beyond the scenes themselves: a client works out where
 * the table is looking from the flag, the same way it works out everything else
 * about a scene.
 */
router.put('/:id/selected', requireDm, async (req, res, next) => {
  try {
    const scenes = await store.list(scenesOf(req));
    if (!scenes.some((s) => s.id === req.params.id)) {
      return res.status(404).json({ error: 'Not found' });
    }
    const changed = [];
    for (const scene of scenes) {
      const should = scene.id === req.params.id;
      // Only what actually moves. A campaign of thirty scenes is one write and
      // one broadcast, not thirty of each.
      if ((scene.selected === true) === should) continue;
      const updated = await store.mutate(scenesOf(req), scene.id, (current) => ({
        ...current,
        selected: should,
      }));
      if (updated) changed.push(updated);
    }
    for (const scene of changed) announce(req, 'update', scene);
    res.json({ selectedId: req.params.id });
  } catch (err) {
    next(err);
  }
});

// ---- Fog of war ----

/**
 * Whether this board is played in the dark, and how its distances are written.
 *
 * A route of its own rather than three fields on the scene edit, for the reason
 * given where sanitizeScene would have carried them: everything in that function
 * is overwritten by any PUT of the scene, so a client saving a name change would
 * quietly turn the lights back on. This one touches nothing but the fog.
 *
 * Arming it changes what every other person at the table is *sent* - see
 * tokensSeenThroughFog - so the announcement that follows is what makes the
 * monsters vanish from their screens, live, without anybody reloading.
 */
router.put('/:id/fog', requireDm, async (req, res, next) => {
  try {
    let fog = null;
    const scene = await store.mutate(scenesOf(req), req.params.id, (current) => {
      fog = sanitizeFog(req.body, current);
      return { ...current, fog };
    });
    if (!scene) return res.status(404).json({ error: 'Not found' });
    announce(req, 'fog:update', scene);
    res.json(fog);
  } catch (err) {
    next(err);
  }
});

// ---- Turn mode ----

/**
 * The tokens that take a turn, in the order they take them.
 *
 * Highest initiative first, and *only* tokens that have one - a door or a pile
 * of crates stands on the board without being in the fight. Ties keep the order
 * they already stand in, which is the order they were added and therefore the
 * same list for everyone looking at it.
 *
 * The client sorts its own copy by this exact rule to draw the list. If one of
 * the two ever changes, the other has to change with it, or the DM's Next would
 * step somewhere other than where the highlight is.
 */
function turnOrder(scene) {
  return (scene.tokens || [])
    .filter((t) => t.initiative !== null && t.initiative !== undefined)
    .sort((a, b) => b.initiative - a.initiative || byModifier(a, b));
}

/**
 * The tie-break: level totals are settled by the bigger modifier.
 *
 * A token whose initiative was typed in as a bare total has no modifier to
 * compare, and sorts below any token that does - it can't win a contest it
 * brought no evidence to. Compared rather than subtracted so that two unknowns
 * are equal instead of NaN, which is what `-Infinity - -Infinity` would give
 * and what a subtracting comparator would quietly scramble the order with.
 */
function byModifier(a, b) {
  const of = (t) =>
    t.initiativeMod === null || t.initiativeMod === undefined ? -Infinity : t.initiativeMod;
  const ma = of(a);
  const mb = of(b);
  if (ma === mb) return 0;
  return mb > ma ? 1 : -1;
}

/**
 * Whose turn it is after this one. Wrapping past the end is the next round.
 *
 * A token that has since been deleted - or had its initiative cleared, which
 * takes it out of the fight just as surely - is no longer in the order, so
 * there is no "next" from it. Starting again from the top beats refusing.
 */
function nextInOrder(scene) {
  const order = turnOrder(scene);
  if (!order.length) return null;
  const i = order.findIndex((t) => t.id === scene.turnTokenId);
  return order[i < 0 ? 0 : (i + 1) % order.length].id;
}

/**
 * Turn mode belongs to the scene, so it is one shared fact rather than
 * something each client decides for itself: the tracker everyone sees is the
 * same tracker, and a player who reloads mid-fight rejoins it where it stands.
 *
 * Deliberately not part of sanitizeScene - an ordinary scene edit (a rename, a
 * new map) has no business ending combat, and a stale client PUT can't.
 */
router.put('/:id/turn', requireDm, async (req, res, next) => {
  try {
    const on = req.body?.on !== false;
    const scene = await store.mutate(scenesOf(req), req.params.id, (current) => ({
      ...current,
      turnMode: on,
      // Starting puts the highest initiative up first. Stopping forgets whose
      // turn it was, so the next fight doesn't open in the middle of the last.
      turnTokenId: on ? (turnOrder(current)[0]?.id ?? null) : null,
    }));
    if (!scene) return res.status(404).json({ error: 'Not found' });
    announce(req, 'update', scene);
    res.json(scene);
  } catch (err) {
    next(err);
  }
});

/**
 * Hand the turn to a particular token, rather than to whoever is next.
 *
 * The order is what a fight *usually* follows, not a rule it can't depart from:
 * someone readies an action, a creature is surprised, initiative gets rerolled
 * mid-round. This is the DM saying "it's yours now" and skipping the argument.
 *
 * Only a token already in the order may take it. One without an initiative
 * isn't in the fight, and giving it the turn would highlight a row that isn't
 * in the list and leave Next with nowhere to step from.
 */
router.put('/:id/turn/current', requireDm, async (req, res, next) => {
  try {
    const wanted = String(req.body?.tokenId || '');
    const scene = await store.mutate(scenesOf(req), req.params.id, (current) => {
      if (!current.turnMode) throw new HttpError(409, 'Turn mode is not on.');
      const token = turnOrder(current).find((t) => t.id === wanted);
      if (!token) throw new HttpError(409, 'That token is not in the turn order.');
      return { ...current, turnTokenId: token.id };
    });
    if (!scene) return res.status(404).json({ error: 'Not found' });
    announce(req, 'update', scene);
    res.json(scene);
  } catch (err) {
    next(err);
  }
});

router.put('/:id/turn/next', requireDm, async (req, res, next) => {
  try {
    const scene = await store.mutate(scenesOf(req), req.params.id, (current) => {
      if (!current.turnMode) throw new HttpError(409, 'Turn mode is not on.');
      return { ...current, turnTokenId: nextInOrder(current) };
    });
    if (!scene) return res.status(404).json({ error: 'Not found' });
    announce(req, 'update', scene);
    res.json(scene);
  } catch (err) {
    next(err);
  }
});

/**
 * Destroy a creature: every figure of it, on every map, and the bench entry.
 *
 * Not "take this figure off this map" - that is what the bench route does, and
 * it is the reversible one. This is the DM's delete, and once a creature can
 * stand on three scenes at once, deleting it on one of them and leaving the
 * others standing would be a cast list you could not clear.
 */
router.delete('/:id/tokens/:tokenId', requireDm, async (req, res, next) => {
  try {
    const { placements } = await placementsOf(req.campaignId, req.params.tokenId);
    if (!placements.length) return res.status(404).json({ error: 'Token not found' });
    const touched = await removeEverywhere(req.campaignId, req.params.tokenId);
    for (const sceneId of touched) {
      const scene = await store.get(scenesOf(req), sceneId);
      if (scene) announce(req, 'token:delete', scene);
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
