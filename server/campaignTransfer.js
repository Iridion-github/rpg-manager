'use strict';

/**
 * A campaign as a file: everything at a table except the people at it.
 *
 * The point is to move a prepared table between servers — your laptop to the
 * one your friends reach, a backup to a fresh install — without carrying
 * accounts across. Which means the one thing deliberately left out is
 * membership, and with it every reference to a user id: token owners and sheet
 * access are *permissions*, and a permission that names someone who doesn't
 * exist on the destination is worse than no permission at all. The importer
 * becomes the DM of what arrives, and hands things out again from there.
 *
 * The shape is versioned because it will be read by a future that has changed
 * its mind about something. `format` is checked before anything else so a JSON
 * file that happens to parse — a package.json, half a save from another app —
 * is refused rather than half-imported.
 */

const store = require('./store');
const { scoped } = require('./campaigns');

const FORMAT = 'rpg-manager-campaign';
const VERSION = 1;

// Every collection a campaign owns. The scoped() prefix is the campaign id, so
// these names are the whole of what "inside a campaign" means.
const COLLECTIONS = ['scenes', 'sheets', 'notes', 'chat', 'music', 'musicState'];

/** Everything under one campaign, as a plain object ready to be JSON. */
async function exportCampaign(campaign) {
  const collections = {};
  for (const name of COLLECTIONS) {
    collections[name] = await store.list(scoped(campaign.id, name));
  }
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    // Not the members, and not the id: this describes a table, not an instance
    // of one. Importing it makes a new campaign, it doesn't restore this one.
    campaign: {
      name: String(campaign.name || ''),
      subtitle: String(campaign.subtitle || ''),
    },
    collections,
  };
}

/**
 * Is this a file we can import?
 *
 * Deliberately shallow. It checks the envelope — the marker, a version we
 * understand, a campaign object, and collections that are arrays of objects —
 * and leaves the contents to the sanitizers that already run on every write.
 * A deep schema check here would be a second copy of those rules, and the copy
 * that drifts is always the one nobody is looking at.
 */
function validate(data) {
  if (!data || typeof data !== 'object') return 'That file is not a campaign export.';
  if (data.format !== FORMAT) return 'That file is not a campaign export.';
  if (!Number.isInteger(data.version) || data.version > VERSION) {
    return `That file was made by a newer version (${data.version}).`;
  }
  if (!data.campaign || typeof data.campaign !== 'object') return 'That export has no campaign in it.';
  if (!data.collections || typeof data.collections !== 'object') {
    return 'That export has nothing in it.';
  }
  for (const [name, records] of Object.entries(data.collections)) {
    if (!COLLECTIONS.includes(name)) return `Unknown section in the file: ${name}.`;
    if (!Array.isArray(records)) return `The ${name} section is not a list.`;
    if (records.some((r) => !r || typeof r !== 'object' || !r.id)) {
      return `The ${name} section has an entry without an id.`;
    }
  }
  return null;
}

/**
 * Strip what belonged to the old server's users.
 *
 * Ids of people are meaningless here, and leaving them in would either name
 * nobody or — worse, on a server where an id happens to match — name the wrong
 * person. Tokens lose their owner, so the DM reassigns them; sheets lose their
 * access map, so nobody inherits sight of a sheet they were never given.
 */
function stripUsers(name, record) {
  if (name === 'scenes') {
    return {
      ...record,
      tokens: (record.tokens || []).map((t) => ({ ...t, ownerId: null })),
      // Shapes remember who drew them, for the same reason tokens remember who
      // owns them — and the id means nothing here. Left in place it would name
      // nobody, or, on the day two servers mint the same id, the wrong person.
      shapes: (record.shapes || []).map((s) => ({ ...s, ownerId: null })),
    };
  }
  if (name === 'sheets') return { ...record, access: {} };
  return record;
}

/** Write an export's contents into a campaign that already exists. */
async function importInto(campaignId, data) {
  const counts = {};
  for (const name of COLLECTIONS) {
    const records = Array.isArray(data.collections?.[name]) ? data.collections[name] : [];
    for (const record of records) {
      await store.put(scoped(campaignId, name), stripUsers(name, record));
    }
    counts[name] = records.length;
  }
  return counts;
}

module.exports = { FORMAT, VERSION, COLLECTIONS, exportCampaign, validate, importInto };
