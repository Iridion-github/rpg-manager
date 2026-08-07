'use strict';

const express = require('express');
const store = require('../store');
const { broadcast } = require('../realtime');
const { requireGm } = require('../auth');

const COLLECTION = 'sheets';
const router = express.Router();

function announce(req, action, record) {
  broadcast(req, 'sheets:changed', { action, record });
}

// Keep only the fields we recognise for a character sheet.
function sanitize(body = {}) {
  const {
    name = 'New Character',
    class: klass = '',
    level = 1,
    hp = 0,
    maxHp = 0,
    ac = 10,
    notes = '',
  } = body;
  return {
    name: String(name).slice(0, 120),
    class: String(klass).slice(0, 120),
    level: Number(level) || 1,
    hp: Number(hp) || 0,
    maxHp: Number(maxHp) || 0,
    ac: Number(ac) || 0,
    notes: String(notes).slice(0, 5000),
  };
}

router.get('/', async (req, res, next) => {
  try {
    res.json(await store.list(COLLECTION));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const record = await store.get(COLLECTION, req.params.id);
    if (!record) return res.status(404).json({ error: 'Not found' });
    res.json(record);
  } catch (err) {
    next(err);
  }
});

router.post('/', requireGm, async (req, res, next) => {
  try {
    const record = await store.create(COLLECTION, sanitize(req.body));
    announce(req, 'create', record);
    res.status(201).json(record);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requireGm, async (req, res, next) => {
  try {
    const record = await store.update(COLLECTION, req.params.id, sanitize(req.body));
    if (!record) return res.status(404).json({ error: 'Not found' });
    announce(req, 'update', record);
    res.json(record);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireGm, async (req, res, next) => {
  try {
    const ok = await store.remove(COLLECTION, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    announce(req, 'delete', { id: req.params.id });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
