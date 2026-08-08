'use strict';

/**
 * Server-wide operations. Admin only, and deliberately few.
 *
 * The backup exists because a mounted disk protects you from restarts, not from
 * mistakes: a bad migration or a campaign deleted in the wrong tab is still
 * gone, and once the app lives on a host somewhere the database is no longer a
 * file you can reach. This makes the whole server something you can pull down
 * and keep.
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const store = require('../store');
const { requireAdmin } = require('../auth');

const router = express.Router();

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

/**
 * Download a consistent snapshot of the whole database.
 *
 * It goes through SQLite's online backup API rather than copying the file,
 * which matters: in WAL mode the committed state is spread across the database
 * and its write-ahead log, so a plain copy of the .db taken while the server is
 * running can be missing the most recent transactions — or be torn outright.
 * backup() cooperates with the writer and hands back a file that opens cleanly.
 *
 * The server keeps running throughout. Restoring is putting this file where
 * DATA_DIR expects it, with the app stopped.
 */
router.get('/backup', requireAdmin, async (req, res, next) => {
  // Somewhere off the mounted disk, so a large snapshot can't fill the volume
  // it is a snapshot of.
  const temp = path.join(os.tmpdir(), `rpg-manager-backup-${crypto.randomUUID()}.db`);
  try {
    await store.db.backup(temp);
    res.download(temp, `rpg-manager-${stamp()}.db`, (err) => {
      // Fires once the transfer finishes or fails; either way the copy is done
      // with. Errors here are logged rather than raised — the response has
      // already begun, so there's nothing left to tell the client.
      fs.rm(temp, { force: true }, () => {});
      if (err) console.error('backup download failed:', err.message);
    });
  } catch (err) {
    fs.rm(temp, { force: true }, () => {});
    next(err);
  }
});

module.exports = router;
