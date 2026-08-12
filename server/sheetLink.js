'use strict';

/**
 * Coupling a token to a character sheet, and keeping the two in step.
 *
 * A token on the map and a sheet in the Characters tab are the same creature
 * seen from two directions: one is where it stands, the other is what it is.
 * Linking them means the numbers they share stop being two numbers.
 *
 * **The link is stored in one place only** - `sheetId` on the token. The sheet
 * holds no pointer back. That is what makes the relation impossible to
 * contradict: with an id at both ends there is a state where they disagree, and
 * then something has to decide which end is lying. Reading "what is this sheet
 * attached to?" costs a scan of the campaign's tokens, which is a list of a few
 * dozen at a table that has been going for years.
 *
 * **One to one, both ways.** A token names at most one sheet by construction -
 * it is a single field. A sheet is held by at most one token because linking
 * releases whatever else was holding it; see `link`.
 *
 * **Which way the numbers flow** is decided per field, by where the field is
 * actually authored:
 *
 *   hit points          both ways. The same number in two places: the DM
 *                       applies damage on the map, the player heals on their
 *                       sheet, and either way both show it.
 *   initiative modifier sheet to token only. On the sheet it is *derived* -
 *                       dexterity plus a bonus - so there is no single number
 *                       for a token edit to write back to. Editing it on the
 *                       token would be editing a shadow.
 *   name, picture, size the token's own, always. A token is often deliberately
 *                       called something else on the map, and the picture and
 *                       the size are facts about the piece rather than the
 *                       character.
 */

const store = require('./store');
const { scoped } = require('./campaigns');

const benchOf = (campaignId) => scoped(campaignId, 'bench');
const scenesOf = (campaignId) => scoped(campaignId, 'scenes');
const sheetsOf = (campaignId) => scoped(campaignId, 'sheets');

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const int = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : fallback);

/**
 * A D&D ability modifier: (score - 10) halved, rounding down.
 *
 * A twin of `abilityMod` in client/src/sheet/rules.js, and deliberately not
 * imported from there - that file is browser code and this is not. Two lines
 * that have been the same since 1974 are a cheaper dependency than a shared
 * module across the client/server boundary, but they do have to stay in step:
 * if one changes, so does the other.
 */
const abilityMod = (score) => Math.floor(((Number(score) || 10) - 10) / 2);

/** What a sheet says its character's initiative modifier is. */
const initiativeModOf = (sheet) =>
  abilityMod(sheet?.abilities?.dex) + int(sheet?.initiativeBonus, 0);

/**
 * The token fields a sheet decides, in the shape a token stores them.
 *
 * `initiative` is recomputed only when the token has a die on record: the total
 * is the roll plus the modifier, so changing the modifier changes the total -
 * but a token whose initiative was typed in as a bare number has no roll to add
 * to, and overwriting that with the modifier alone would replace an answer with
 * a fragment of one.
 */
function tokenFieldsFromSheet(sheet, token = {}) {
  const initiativeMod = initiativeModOf(sheet);
  const fields = {
    maxHp: clamp(int(sheet?.hp?.max, 0), 0, 9999),
    hp: clamp(int(sheet?.hp?.current, 0), 0, 9999),
    initiativeMod,
  };
  if (token.initiativeDie !== null && token.initiativeDie !== undefined) {
    fields.initiativeDie = token.initiativeDie;
    fields.initiative = clamp(int(token.initiativeDie, 0) + initiativeMod, -99, 999);
  }
  return fields;
}

/**
 * Every token in the campaign, with where it lives, so a caller can write it
 * back. Tokens are in two places - the bench, and inside each scene's `tokens`
 * array - and every operation here has to work on both.
 */
async function allTokens(campaignId) {
  const found = [];
  for (const token of await store.list(benchOf(campaignId))) {
    found.push({ token, where: 'bench' });
  }
  for (const scene of await store.list(scenesOf(campaignId))) {
    for (const token of scene.tokens || []) {
      found.push({ token, where: 'scene', sceneId: scene.id });
    }
  }
  return found;
}

/** The token holding this sheet, or null. */
async function tokenForSheet(campaignId, sheetId) {
  if (!sheetId) return null;
  return (await allTokens(campaignId)).find((t) => t.token.sheetId === sheetId) || null;
}

/** Write a patch onto one token, wherever it happens to live. */
async function patchToken(campaignId, found, patch) {
  if (found.where === 'bench') {
    await store.put(benchOf(campaignId), { ...found.token, ...patch });
    return;
  }
  await store.mutate(scenesOf(campaignId), found.sceneId, (scene) => ({
    ...scene,
    tokens: (scene.tokens || []).map((t) => (t.id === found.token.id ? { ...t, ...patch } : t)),
  }));
}

/**
 * Couple a token to a sheet, releasing whatever else held either of them.
 *
 * The token's own previous sheet needs no clearing - `sheetId` is one field and
 * the new value replaces it. The sheet's previous *token* does: that is a
 * different record, and leaving it pointing here is what "one sheet, one token"
 * exists to prevent. Released rather than refused, because the DM dragging a
 * character onto a different figure means to move it, not to be told no.
 *
 * Returns the fields written onto the token, so the caller can answer with a
 * token that matches what was stored.
 */
async function link(campaignId, found, sheet) {
  const holder = await tokenForSheet(campaignId, sheet.id);
  if (holder && holder.token.id !== found.token.id) {
    await patchToken(campaignId, holder, { sheetId: null });
  }
  const patch = { sheetId: sheet.id, ...tokenFieldsFromSheet(sheet, found.token) };
  await patchToken(campaignId, found, patch);
  return patch;
}

/** Uncouple one token. The sheet is untouched - it never knew. */
async function unlink(campaignId, found) {
  // Its hit points stay where they are. They were the character's a moment ago
  // and they are the token's now: a figure that healed to full on being taken
  // off its sheet would be a strange thing to have happen mid-fight.
  await patchToken(campaignId, found, { sheetId: null });
  return { sheetId: null };
}

/**
 * A sheet has changed - carry it to the token holding it, if any.
 *
 * Cheap when nothing is linked, which is the common case: one scan of the
 * campaign's tokens and no writes.
 */
async function pushSheetToToken(campaignId, sheet) {
  if (!sheet?.id) return;
  const found = await tokenForSheet(campaignId, sheet.id);
  if (!found) return;
  const patch = tokenFieldsFromSheet(sheet, found.token);
  // Nothing to write is the usual answer - most sheet edits are about spells
  // and inventory, and a write here would broadcast a scene change to the whole
  // table for a note nobody can see on the map.
  const same = Object.entries(patch).every(([key, value]) => found.token[key] === value);
  if (same) return;
  await patchToken(campaignId, found, patch);
}

/**
 * A token's hit points have changed - carry them back to its sheet.
 *
 * Only the hit points. The modifier is the sheet's to decide and the rest of
 * the token was never the sheet's business, so this writes exactly the two
 * numbers that mean the same thing at both ends.
 */
async function pushTokenToSheet(campaignId, token) {
  if (!token?.sheetId) return null;
  const sheet = await store.get(sheetsOf(campaignId), token.sheetId);
  if (!sheet) return null;
  const max = clamp(int(token.maxHp, 0), 0, 999);
  const current = clamp(int(token.hp, 0), -99, 999);
  if (sheet.hp?.max === max && sheet.hp?.current === current) return null;
  // Returned so the caller can tell the table. Writing this to disk without
  // saying so left an open sheet window showing the hit points the character
  // had before it was hit, until whoever was reading it happened to reload.
  return store.mutate(sheetsOf(campaignId), sheet.id, (currentSheet) => ({
    ...currentSheet,
    hp: { ...currentSheet.hp, max, current },
  }));
}

/**
 * A sheet is being deleted - release the token that held it.
 *
 * Without this the token keeps an id that resolves to nothing, which is not
 * dangerous but is a link the interface would have to explain. The token keeps
 * the numbers it had.
 */
async function releaseSheet(campaignId, sheetId) {
  const found = await tokenForSheet(campaignId, sheetId);
  if (found) await patchToken(campaignId, found, { sheetId: null });
}

module.exports = {
  abilityMod,
  initiativeModOf,
  tokenFieldsFromSheet,
  allTokens,
  tokenForSheet,
  patchToken,
  link,
  unlink,
  pushSheetToToken,
  pushTokenToSheet,
  releaseSheet,
};
