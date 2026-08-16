'use strict';

/**
 * Copies of a token, and what the app remembers about them.
 *
 * A token can be copied and pasted onto the board, and the copy is meant to be
 * indistinguishable from the thing it came from - same face, same size, same
 * numbers. Two facts are kept about it anyway, and they are kept because
 * "identical" is exactly what makes them impossible to work out later:
 *
 *   copyOf     the id of the token this one was copied from, or null on a
 *              token nobody copied. Never the id of another *copy* - see
 *              rootIdOf - so every copy of one creature points at the same
 *              place and the family can be counted with one comparison.
 *   copyIndex  the number it was given when it was pasted, which is what its
 *              name says in brackets.
 *
 * Neither is shown anywhere. They exist so the app can answer "is this one a
 * copy", "a copy of what" and "how many of these are there" without anybody
 * having to keep a list in their head or in a token's name.
 *
 * **How many is counted, never stored.** A number written onto a token is a
 * number that goes stale the moment somebody deletes one of its siblings; the
 * tokens themselves are the count, and they are the only thing that cannot be
 * wrong about it.
 */

const store = require('./store');
const { scoped } = require('./campaigns');

const scenesOf = (campaignId) => scoped(campaignId, 'scenes');
const benchOf = (campaignId) => scoped(campaignId, 'bench');

/**
 * The token at the head of this one's family: itself, or whatever it was
 * copied from.
 *
 * A copy of a copy belongs to the same family as the copy it came from, rather
 * than starting a family of its own. The alternative is a chain, and a chain
 * turns "how many of these are there" into a walk that can be broken in the
 * middle by one deletion - three goblins would answer the question three
 * different ways depending on which of them you asked.
 */
const rootIdOf = (token) => (token && token.copyOf ? token.copyOf : token && token.id) || null;

/**
 * Every token in the campaign, once each, on a scene or on the bench.
 *
 * Once each is the point. A token can stand on more than one map at a time -
 * the same creature, the same id, a position per scene - so walking the scenes
 * and pushing what is found would count the recurring innkeeper twice, and
 * everything built on this counts things.
 */
async function everyToken(campaignId) {
  const scenes = await store.list(scenesOf(campaignId));
  const byId = new Map();
  for (const scene of scenes) {
    for (const token of scene.tokens || []) if (!byId.has(token.id)) byId.set(token.id, token);
  }
  for (const token of await store.list(benchOf(campaignId))) {
    if (!byId.has(token.id)) byId.set(token.id, token);
  }
  return [...byId.values()];
}

/**
 * Find one, wherever it happens to be.
 *
 * Campaign-wide rather than scene-wide because copying and pasting are two
 * separate acts with a session's worth of room between them: the token that was
 * copied may have been taken off the table, or the map may have been changed,
 * by the time somebody pastes it.
 */
async function locateToken(campaignId, tokenId) {
  const benched = await store.get(benchOf(campaignId), tokenId);
  if (benched) return { where: 'bench', token: benched };
  const scenes = await store.list(scenesOf(campaignId));
  for (const scene of scenes) {
    const token = (scene.tokens || []).find((t) => t.id === tokenId);
    if (token) return { where: 'scene', token, sceneId: scene.id };
  }
  return null;
}

/**
 * Everywhere a token is at once: the bench entry if it has one, and every scene
 * it is standing on.
 *
 * The plural of locateToken, and the thing every write about a token needs -
 * renaming a creature that stands on three maps has to rename it on all three,
 * or the campaign would hold three answers to what it is called. Scene names
 * come back with it because the callers report them to people.
 */
async function placementsOf(campaignId, tokenId) {
  const benched = await store.get(benchOf(campaignId), tokenId);
  const scenes = await store.list(scenesOf(campaignId));
  const placements = [];
  for (const scene of scenes) {
    const token = (scene.tokens || []).find((t) => t.id === tokenId);
    if (token) {
      placements.push({
        where: 'scene',
        token,
        sceneId: scene.id,
        sceneName: scene.name || 'Untitled scene',
      });
    }
  }
  return { bench: benched ? { where: 'bench', token: benched } : null, placements };
}

/**
 * The fields that belong to a *placement* rather than to the creature.
 *
 * Where it stands, and nothing else. Everything else a token carries - its
 * name, its face, its hit points, who it belongs to, what it is suffering from
 * - is a fact about the creature, and a creature standing on three maps is one
 * creature. So an edit made on one map is written onto all of them, minus these.
 */
const PER_PLACEMENT = ['x', 'y'];

/**
 * Write a patch onto every copy of a token, wherever it is standing.
 *
 * `exceptSceneId` skips the one the caller has already written, which is the
 * ordinary case: a route mutates the scene it was called about and then asks
 * this to catch the others up. Answers with the scenes it touched, so the caller
 * can tell the tables looking at them.
 */
async function patchEverywhere(campaignId, tokenId, patch = {}, { exceptSceneId = null } = {}) {
  const clean = { ...patch };
  for (const key of [...PER_PLACEMENT, 'id']) delete clean[key];
  const { bench, placements } = await placementsOf(campaignId, tokenId);
  const touched = [];
  for (const placement of placements) {
    if (placement.sceneId === exceptSceneId) continue;
    await store.mutate(scenesOf(campaignId), placement.sceneId, (scene) => ({
      ...scene,
      tokens: (scene.tokens || []).map((t) => (t.id === tokenId ? { ...t, ...clean } : t)),
    }));
    touched.push(placement.sceneId);
  }
  // A token standing anywhere has no bench entry, but patching one that somehow
  // exists costs a write and closes the gap rather than leaving two answers.
  if (bench) await store.put(benchOf(campaignId), { ...bench.token, ...clean });
  return touched;
}

/**
 * Take a token off every map it stands on, and off the bench.
 *
 * What "delete this creature" has to mean once one creature can be in several
 * places: leaving the other figures behind would be leaving copies nobody can
 * reach from the cast list. Answers with the scenes it emptied.
 */
async function removeEverywhere(campaignId, tokenId) {
  const { bench, placements } = await placementsOf(campaignId, tokenId);
  const touched = [];
  for (const placement of placements) {
    await store.mutate(scenesOf(campaignId), placement.sceneId, (scene) => ({
      ...scene,
      tokens: (scene.tokens || []).filter((t) => t.id !== tokenId),
      // A token that was taking its turn isn't taking it any more.
      turnTokenId: scene.turnTokenId === tokenId ? null : scene.turnTokenId,
    }));
    touched.push(placement.sceneId);
  }
  if (bench) await store.remove(benchOf(campaignId), tokenId);
  return touched;
}

/** How many copies of this original the campaign is holding right now. */
async function countCopies(campaignId, rootId) {
  if (!rootId) return 0;
  const all = await everyToken(campaignId);
  return all.filter((t) => t.copyOf === rootId).length;
}

/**
 * A name with any copy number taken back off it.
 *
 * So that copying "Ogre (Copy 2)" gives "Ogre (Copy 3)" rather than "Ogre (Copy
 * 2) (Copy 3)": what somebody wants a second time is another ogre, and the
 * brackets are the app's bookkeeping rather than part of what the creature is
 * called. Only the suffix this app writes is taken off, and only from the end -
 * a token somebody deliberately called "Mirror Image (Copy)" keeps its name.
 */
const COPY_SUFFIX = /\s*\(Copy \d+\)$/;

const baseLabelOf = (label) => String(label ?? '').replace(COPY_SUFFIX, '').trim();

/**
 * What a copy is called: the original's name, and how many of them there are.
 *
 * The number is a count and not an identifier - delete one of three copies and
 * the next paste is the third again - which is why nothing is looked up by it.
 * The id is the identity; this is a label, and it stays editable like any other.
 */
function copyLabelFor(sourceLabel, count) {
  const base = baseLabelOf(sourceLabel) || 'Token';
  // 60 is what a token's label is cut to on the way into storage. Cutting the
  // base rather than the whole thing keeps the number, which is the part that
  // tells two of them apart.
  const suffix = ` (Copy ${count})`;
  return `${base.slice(0, 60 - suffix.length)}${suffix}`;
}

module.exports = {
  rootIdOf,
  locateToken,
  placementsOf,
  patchEverywhere,
  removeEverywhere,
  countCopies,
  baseLabelOf,
  copyLabelFor,
};
