'use strict';

/**
 * Bring a JSON data folder into the database, once.
 *
 * Two shapes can be on disk, and this handles both:
 *
 *   data/users.json, data/campaigns.json, data/campaigns/<id>/sheets.json …
 *       the layout since campaigns existed. Each file is one collection.
 *
 *   data/players.json, data/sheets.json, data/scenes.json …
 *       the flat layout from before campaigns. Those files are somebody's
 *       actual game, so they're folded into a campaign rather than left behind
 *       for a fresh empty one.
 *
 * Runs only when the database has no records at all — that emptiness is the
 * "not yet imported" marker, so a second start does nothing. Source files are
 * renamed to *.imported rather than deleted: this is the one irreversible-
 * looking step in the project and a backup costs nothing.
 *
 * Timestamps are carried across as they were. Importing is not the same event
 * as creating, and a campaign that shows "created today" because you changed
 * database engines would be a small lie told by the software.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./store');
const { newUserKey, colorFor, ADMIN_USERNAME } = require('./auth');

// Collections that belong to a campaign. Finding one of these loose at the top
// level is what identifies the pre-campaign layout.
const SCOPED = ['sheets', 'scenes', 'chat', 'notes', 'music', 'musicState'];

const insert = store.db.prepare(`
  INSERT OR REPLACE INTO records (collection, id, data, created_at, updated_at)
  VALUES (@collection, @id, @data, @createdAt, @updatedAt)
`);

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// Collect every JSON file worth importing, as { collection, file, records }.
function findSources(dir) {
  const found = [];
  if (!fs.existsSync(dir)) return found;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      found.push({ collection: entry.name.replace(/\.json$/, ''), file: path.join(dir, entry.name) });
    }
  }

  // One directory deep: data/campaigns/<uuid>/<collection>.json
  const campaignsDir = path.join(dir, 'campaigns');
  if (fs.existsSync(campaignsDir)) {
    for (const entry of fs.readdirSync(campaignsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isUuid(entry.name)) continue;
      const inner = path.join(campaignsDir, entry.name);
      for (const file of fs.readdirSync(inner)) {
        if (!file.endsWith('.json')) continue;
        found.push({
          collection: `campaigns/${entry.name}/${file.replace(/\.json$/, '')}`,
          file: path.join(inner, file),
        });
      }
    }
  }
  return found;
}

async function importJson() {
  if (!store.isEmpty()) return null; // already holds data — nothing to do

  const sources = findSources(store.DATA_DIR);
  if (sources.length === 0) return null; // fresh install

  // Load everything first. Nothing is written until it all parses, so a corrupt
  // file fails the import rather than half-doing it.
  const loaded = sources.map((s) => ({ ...s, records: readJson(s.file) }));
  const byCollection = new Map(loaded.map((s) => [s.collection, s]));

  const legacyFlat = SCOPED.filter((name) => byCollection.has(name));
  const extra = []; // records this migration invents rather than reads

  // players.json was the roster before people had accounts. Ids are kept: token
  // ownerIds and per-sheet access maps point at them, and rewriting those is a
  // migration that can half-succeed.
  const players = byCollection.get('players');
  if (players && !byCollection.has('users')) {
    for (const player of Object.values(players.records)) {
      player.globalRole = 'user';
    }
    players.collection = 'users';
    // Re-key the lookup as well as the record. Renaming only the object leaves
    // the map answering `get('users')` with nothing, and the campaign built
    // below would then have no members but its DM.
    byCollection.delete('players');
    byCollection.set('users', players);
  }

  if (legacyFlat.length > 0 && !byCollection.has('campaigns')) {
    const users = Object.values(byCollection.get('users')?.records || {});
    let admin = users.find((u) => u.globalRole === 'admin');
    if (!admin) {
      // Before campaigns the GM was a password, not a person, so there may be
      // no admin record to make the DM of the imported campaign.
      admin = {
        id: crypto.randomUUID(),
        name: 'Admin',
        username: ADMIN_USERNAME,
        color: colorFor(users.length),
        key: newUserKey(),
        globalRole: 'admin',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      extra.push({ collection: 'users', record: admin });
    }

    const members = { [admin.id]: 'dm' };
    for (const user of users) if (user.id !== admin.id) members[user.id] = 'player';

    const campaignId = crypto.randomUUID();
    const stamp = new Date().toISOString();
    extra.push({
      collection: 'campaigns',
      record: {
        id: campaignId,
        name: 'Imported Campaign',
        description: 'Everything that existed before campaigns did.',
        members,
        createdAt: stamp,
        updatedAt: stamp,
      },
    });

    // Re-home the loose files under the campaign that now owns them.
    for (const name of legacyFlat) {
      byCollection.get(name).collection = `campaigns/${campaignId}/${name}`;
    }
  }

  let count = 0;
  const run = store.db.transaction(() => {
    for (const source of loaded) {
      if (source.collection === 'players') continue; // became users above
      for (const [id, record] of Object.entries(source.records)) {
        const full = { ...record, id };
        insert.run({
          collection: source.collection,
          id,
          data: JSON.stringify(full),
          createdAt: full.createdAt || new Date().toISOString(),
          updatedAt: full.updatedAt || full.createdAt || new Date().toISOString(),
        });
        count++;
      }
    }
    for (const { collection, record } of extra) {
      insert.run({
        collection,
        id: record.id,
        data: JSON.stringify(record),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
      count++;
    }
  });
  run();

  // Only once the transaction has committed. A failure above leaves the files
  // exactly where they were, so the next start tries again.
  for (const source of loaded) fs.renameSync(source.file, `${source.file}.imported`);

  return { records: count, files: loaded.length, foldedIntoCampaign: legacyFlat.length > 0 };
}

module.exports = { importJson };
