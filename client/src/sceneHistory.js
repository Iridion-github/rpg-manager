// What Undo knows how to reverse on the tabletop.
//
// Each recorder here turns one action into the pair of calls that take it back
// and put it again, and hands them to the stack in history.js. They go through
// the ordinary API - there is no special undo endpoint - so the server checks
// permission on a reversal exactly as it checked the action, and a player can
// no more undo their way into moving somebody else's token than they could move
// it in the first place.
//
// Every reversal is guarded by the same rule: the thing must still be as this
// action left it. If someone else has moved that token, or retuned that grid,
// since you did, the entry refuses and says so. Reversing anyway would be
// reaching into their work, which is the one thing this feature must not do.

import { api } from './api.js';
import { record, stale } from './history.js';

// Positions are floats - a token placed on a gridless map lands on fractions of
// a cell - so "the same place" is a tolerance, not an equality. Matches
// SAME_SPOT on the map and on the server, for the same reason they match each
// other: three ideas of "the same square" would eventually disagree.
const SAME = 0.02;

/**
 * Whether every field `expected` names still holds that value on `current`.
 *
 * Numbers compare within the tolerance above. Null and undefined count as the
 * same answer: a field the server has never stored reads as one and a field it
 * stored empty reads as the other, and neither is a change somebody made.
 */
export function matches(current, expected) {
  return Object.entries(expected).every(([key, want]) => {
    const have = current?.[key];
    if (typeof want === 'number' && typeof have === 'number') return Math.abs(have - want) < SAME;
    if (want === null || want === undefined) return have === null || have === undefined;
    return have === want;
  });
}

/**
 * The fields of `obj` that `keys` names, and no others.
 *
 * A field the record simply doesn't have stays undefined rather than becoming
 * null: JSON drops it on the way out, and the server then keeps whatever it
 * already had - which is what "this action never touched that" should mean. A
 * null would instead be read as a value and written over the top of one.
 */
export const pick = (obj, keys) => Object.fromEntries(keys.map((key) => [key, obj?.[key]]));

// A token to send back as a new one. The id goes: the server mints its own on
// every add, and asking it to reuse a dead one is not a thing it offers.
const withoutId = ({ id, ...fields }) => fields;

async function sceneNow(sceneId) {
  try {
    return await api.getScene(sceneId);
  } catch (err) {
    if (err.status === 404) throw stale('That scene has been deleted since.');
    throw err;
  }
}

async function tokenNow(sceneId, tokenId) {
  const scene = await sceneNow(sceneId);
  const token = (scene.tokens || []).find((t) => t.id === tokenId);
  if (!token) throw stale('That token is no longer on the map.');
  return token;
}

/**
 * The guard every token reversal runs first: read the token as it stands now,
 * and only reverse if it is still exactly as this action left it.
 */
async function ifUntouched(sceneId, tokenId, expected, complaint, apply) {
  const token = await tokenNow(sceneId, tokenId);
  if (!matches(token, expected)) throw stale(complaint);
  return apply();
}

/** Moving a token: back to where it came from, and out to where it went. */
export function recordTokenMove({ sceneId, tokenId, label, from, to }) {
  const name = label || 'That token';
  const step = (expected, target) => () =>
    ifUntouched(
      sceneId,
      tokenId,
      expected,
      `${name} has been moved by someone else since - that move is no longer yours to take back.`,
      () => api.moveToken(sceneId, tokenId, target.x, target.y)
    );

  record({
    label: `move ${name}`,
    sceneId,
    undo: step(to, from),
    redo: step(from, to),
  });
}

/** Editing one: back to the fields it had, and out to the ones you gave it. */
export function recordTokenEdit({ sceneId, tokenId, label, before, after }) {
  const name = label || 'That token';
  const step = (expected, next) => () =>
    ifUntouched(
      sceneId,
      tokenId,
      expected,
      `${name} has been edited by someone else since - that edit is no longer yours to take back.`,
      () => api.updateToken(sceneId, tokenId, next)
    );

  record({
    label: `edit ${name}`,
    sceneId,
    undo: step(after, before),
    redo: step(before, after),
  });
}

/**
 * Creating one. Undo takes it off the map; redo puts it back - as a *new*
 * token, since the server names its own. The entry follows the id it made, or a
 * second undo would go looking for one that no longer exists.
 */
export function recordTokenAdd({ sceneId, token }) {
  const live = { id: token.id };
  record({
    label: `create ${token.label || 'that token'}`,
    sceneId,
    undo: async () => {
      await tokenNow(sceneId, live.id); // gone already? then there's nothing of ours here
      await api.deleteToken(sceneId, live.id);
    },
    redo: async () => {
      const again = await api.addToken(sceneId, withoutId(token));
      live.id = again.id;
    },
  });
}

/**
 * Pasting a copy of one. Undo takes it back off the map; redo pastes again.
 *
 * A recorder of its own rather than recordTokenAdd, because putting this token
 * back is not the same call as putting an ordinary new one back: what makes a
 * copy a copy - which token it came from, and the number in its name - is
 * decided by the paste endpoint and cannot be sent to the plain add. Redoing
 * through the same door is also what keeps the number honest, since the count
 * it is read from is back to what it was the moment undo removed this one.
 */
export function recordTokenPaste({ sceneId, sourceId, token, x, y }) {
  const live = { id: token.id };
  record({
    label: `paste ${token.label || 'that token'}`,
    sceneId,
    undo: async () => {
      await tokenNow(sceneId, live.id); // gone already? then there's nothing of ours here
      // Deleted as one of the campaign's tokens rather than through the scene's
      // own door, which is the DM's alone. A player may paste a copy of their
      // own familiar, so a player has to be able to take it back, and the
      // campaign's delete asks the question that actually applies: is this
      // token yours? Undoing is not a second authority.
      await api.deleteCampaignToken(live.id);
    },
    redo: async () => {
      const again = await api.pasteToken(sceneId, sourceId, x, y);
      live.id = again.id;
    },
  });
}

/** Deleting one - the same pair the other way round. */
export function recordTokenDelete({ sceneId, token }) {
  const live = { id: token.id };
  record({
    label: `delete ${token.label || 'that token'}`,
    sceneId,
    undo: async () => {
      const again = await api.addToken(sceneId, withoutId(token));
      live.id = again.id;
    },
    redo: async () => {
      await tokenNow(sceneId, live.id);
      await api.deleteToken(sceneId, live.id);
    },
  });
}

async function shapeNow(sceneId, shapeId) {
  const scene = await sceneNow(sceneId);
  const shape = (scene.shapes || []).find((s) => s.id === shapeId);
  if (!shape) throw stale('That shape is no longer on the map.');
  return shape;
}

/** Drawing one. Undo rubs it out; redo draws it again, as a new shape. */
export function recordShapeAdd({ sceneId, shape }) {
  const live = { id: shape.id };
  record({
    label: 'draw that shape',
    sceneId,
    undo: async () => {
      await shapeNow(sceneId, live.id);
      await api.deleteShape(sceneId, live.id);
    },
    redo: async () => {
      const again = await api.addShape(sceneId, withoutId(shape));
      live.id = again.id;
    },
  });
}

/** Rubbing one out - the same pair the other way round. */
export function recordShapeDelete({ sceneId, shape }) {
  const live = { id: shape.id };
  record({
    label: 'rub out that shape',
    sceneId,
    undo: async () => {
      const again = await api.addShape(sceneId, withoutId(shape));
      live.id = again.id;
    },
    redo: async () => {
      await shapeNow(sceneId, live.id);
      await api.deleteShape(sceneId, live.id);
    },
  });
}

/**
 * The obscuration, which is one record rather than a list of them.
 *
 * That is the whole difference from the drawn shapes above, and it makes these
 * simpler in one way and fussier in another. Simpler because there is no
 * per-shape route and nothing mints an id, so a shape put back comes back as
 * *itself* - no `live.id` to chase. Fussier because the record carries two
 * things this must not touch: whether the table is looking at it, and the DM's
 * working opacity. Neither is part of drawing a shape, so both are read fresh
 * at the moment of reversal and written back unchanged. Undoing a shape you
 * drew ten minutes ago must not also un-apply the obscuration you switched on
 * since.
 */
async function obscurationNow(sceneId) {
  const scene = await sceneNow(sceneId);
  return scene.obscuration || { on: false, opacity: 60, shapes: [] };
}

/** Write a new list of shapes, leaving the switch and the opacity as they are. */
async function putShapes(sceneId, shapes) {
  const now = await obscurationNow(sceneId);
  await api.setObscuration(sceneId, { ...now, shapes });
}

const hasShape = (shapes, id) => shapes.some((s) => s.id === id);

/**
 * A shape put back goes back where it was, not on the end.
 *
 * Order is not decoration here: the clearing shapes are painted after the
 * obscuring ones, and among themselves the later one wins. A shape that came
 * back at the wrong end of the list would come back meaning something slightly
 * different from the one that was taken away.
 */
const insertAt = (shapes, shape, index) => {
  const next = shapes.slice();
  next.splice(Math.min(index, next.length), 0, shape);
  return next;
};

export function recordObscureAdd({ sceneId, shape }) {
  record({
    label: 'draw that',
    sceneId,
    undo: async () => {
      const now = await obscurationNow(sceneId);
      if (!hasShape(now.shapes, shape.id)) {
        throw stale('That shape has already gone.');
      }
      await putShapes(sceneId, now.shapes.filter((s) => s.id !== shape.id));
    },
    redo: async () => {
      const now = await obscurationNow(sceneId);
      if (hasShape(now.shapes, shape.id)) return;
      await putShapes(sceneId, [...now.shapes, shape]);
    },
  });
}

export function recordObscureDelete({ sceneId, shape, index }) {
  record({
    label: 'rub that out',
    sceneId,
    undo: async () => {
      const now = await obscurationNow(sceneId);
      if (hasShape(now.shapes, shape.id)) return;
      await putShapes(sceneId, insertAt(now.shapes, shape, index));
    },
    redo: async () => {
      const now = await obscurationNow(sceneId);
      if (!hasShape(now.shapes, shape.id)) return;
      await putShapes(sceneId, now.shapes.filter((s) => s.id !== shape.id));
    },
  });
}

/**
 * Moving, stretching, turning: every change to a shape already down.
 *
 * `before` and `after` hold only the fields the action touched, so reversing
 * puts those back and leaves the rest of the shape as it now stands - the same
 * rule the scene's own editor follows, and what makes two people fiddling with
 * different halves of one shape survive each other.
 */
export function recordObscureEdit({ sceneId, shapeId, before, after }) {
  const step = (expected, next) => async () => {
    const now = await obscurationNow(sceneId);
    const shape = now.shapes.find((s) => s.id === shapeId);
    if (!shape) throw stale('That shape is no longer on the map.');
    if (!matches(shape, expected)) {
      throw stale('That shape has been changed since - this is no longer yours to take back.');
    }
    await putShapes(
      sceneId,
      now.shapes.map((s) => (s.id === shapeId ? { ...s, ...next } : s))
    );
  };

  record({
    label: 'change that',
    sceneId,
    undo: step(after, before),
    redo: step(before, after),
  });
}

/**
 * Clearing the board. One entry, so one Ctrl+Z brings the whole lot back.
 *
 * The shapes come back as *new* shapes - the server names every one it's given
 * - so the entry follows the ids it made, exactly as the single-shape
 * recorders do, or a second undo would go looking for shapes nobody has.
 */
export function recordShapesCleared({ sceneId, shapes }) {
  const live = shapes.map((shape) => ({ ...shape }));
  record({
    label: `clear ${shapes.length} shape${shapes.length === 1 ? '' : 's'}`,
    sceneId,
    undo: async () => {
      for (const [i, shape] of live.entries()) {
        const again = await api.addShape(sceneId, withoutId(shape));
        live[i] = { ...shape, id: again.id };
      }
    },
    redo: async () => {
      for (const shape of live) {
        try {
          await api.deleteShape(sceneId, shape.id);
        } catch (err) {
          // One that somebody has already taken off is one less to take off.
          // Anything else is a real failure and belongs in front of the user.
          if (err.status !== 404) throw err;
        }
      }
    },
  });
}

/**
 * Changing one: moved, resized, recoloured.
 *
 * Guarded like every other reversal - if somebody else has since changed the
 * same shape, this refuses rather than reaching into their work. A shape can
 * only be changed by the hand that drew it or by the DM, so in practice that
 * somebody is the DM tidying up behind you.
 */
export function recordShapeEdit({ sceneId, shapeId, before, after }) {
  const step = (expected, next) => async () => {
    const shape = await shapeNow(sceneId, shapeId);
    if (!matches(shape, expected)) {
      throw stale('That shape has been changed by someone else since - it is no longer yours to take back.');
    }
    await api.updateShape(sceneId, shapeId, next);
  };
  record({ label: 'change that shape', sceneId, undo: step(after, before), redo: step(before, after) });
}

/**
 * Taking a token off the table, and putting it back.
 *
 * These two are each other's opposite, so one pair of calls serves both - which
 * is only true because a token keeps its id across the move. It is the same
 * token in both places, and undo can therefore name it without having to guess
 * which of several look-alikes it meant.
 */
export function recordTokenBench({ sceneId, token }) {
  const name = token.label || 'that token';
  record({
    label: `take ${name} off the table`,
    sceneId,
    // Back to the square it was standing on. The server slides it to the
    // nearest free one if somebody has since parked there.
    undo: () => api.spawnToken(sceneId, token.id, token.x, token.y),
    redo: async () => {
      await tokenNow(sceneId, token.id);
      await api.benchToken(sceneId, token.id);
    },
  });
}

export function recordTokenSpawn({ sceneId, token }) {
  const name = token.label || 'that token';
  record({
    label: `put ${name} on the table`,
    sceneId,
    undo: async () => {
      await tokenNow(sceneId, token.id);
      await api.benchToken(sceneId, token.id);
    },
    redo: () => api.spawnToken(sceneId, token.id, token.x, token.y),
  });
}

// What to call a scene change in a message, by the field it touched. Several
// fields can move together - a new map brings its own width and height - so the
// first one named is the one that gets to speak for the change.
/**
 * The no-Ctrl+Z list: things that are never taken back by an undo.
 *
 * Undo is for putting right what you did to your own board. A few actions are
 * not that, and this is where they are written down.
 *
 * **Setting the selected scene** is the one on it. It is not an edit, it is an
 * announcement: every player's board changes to that scene at once, whatever
 * they were looking at. Taking it back with a keystroke - very likely a
 * keystroke aimed at something else entirely, several actions later - would
 * swing the whole table's view back to a map the DM had deliberately moved them
 * off, and nobody at the table would know why. What the DM shows the table is
 * decided by choosing it, and undecided the same way.
 *
 * Written as the *fields* an action would have to write, rather than as a list
 * of names, because that is what the guard below can actually check: a field
 * here cannot be recorded however it comes to be changed - directly, or by some
 * later refactoring that routes it through patchScene without noticing.
 */
export const NEVER_UNDOABLE = new Set(['selected']);

const SCENE_FIELDS = {
  gridSize: 'cell size',
  gridOn: 'grid',
  gridOffsetX: 'grid position',
  gridOffsetY: 'grid position',
  imageUrl: 'map',
  width: 'map',
  height: 'map',
  name: 'scene name',
};

/**
 * A change to the scene itself: the grid, the map under it, its name.
 *
 * `before` and `after` hold the same fields - only the ones the action touched,
 * so reversing puts those back and leaves everything else on the scene exactly
 * as it is now, whoever else has been at it in the meantime.
 */
export function recordSceneEdit({ sceneId, before, after }) {
  // Anything on the no-Ctrl+Z list is dropped rather than refused: an action
  // that changed one of those *and* something ordinary is still worth being
  // able to take the ordinary half of back. When nothing but the exempt field
  // moved, there is no entry at all - which is what makes the guarantee.
  const keys = Object.keys(after).filter((k) => !NEVER_UNDOABLE.has(k));
  if (!keys.length) return;
  const only = (fields) => Object.fromEntries(keys.map((k) => [k, fields[k]]));
  const [was, now] = [only(before), only(after)];
  const what = SCENE_FIELDS[keys[0]] || 'scene';
  const step = (expected, next) => async () => {
    const scene = await sceneNow(sceneId);
    if (!matches(scene, expected)) {
      throw stale(`The ${what} has been changed by someone else since - that change is no longer yours to take back.`);
    }
    await api.updateScene(sceneId, { ...scene, ...next });
  };

  record({
    label: `change the ${what}`,
    sceneId,
    undo: step(now, was),
    redo: step(was, now),
  });
}
