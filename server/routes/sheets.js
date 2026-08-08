'use strict';

const express = require('express');
const store = require('../store');
const { broadcast } = require('../realtime');
const { requireGm } = require('../auth');
const { sanitizeSheet: sanitize } = require('../sheetSchema');

const COLLECTION = 'sheets';
const router = express.Router();

function announce(req, action, record) {
  broadcast(req, 'sheets:changed', { action, record });
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
