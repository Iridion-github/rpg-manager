'use strict';

/**
 * Campaign CRUD and membership.
 *
 * Any signed-in user can start a campaign and is its DM from the first moment —
 * that's what makes "DM at my table, player at yours" work without anyone
 * brokering it.
 *
 * The *list* is a public directory: every signed-in user can see that a
 * campaign exists, what it's called, how busy it is and whether it's still
 * being run. What it never reveals is who is at a table — only how many. And
 * seeing a campaign gets you nothing beyond seeing it: its sheets, scenes, chat
 * and notes stay member-only, enforced before any of those routes run.
 */

const express = require('express');
const store = require('../store');
const { notifyUser } = require('../realtime');
const { requireUser, USERS, publicUser } = require('../auth');
const {
  CAMPAIGNS,
  isMember,
  isDm,
  roleIn,
  sanitizeCampaign,
  sanitizeMembers,
  publicSummary,
  removeCampaignData,
} = require('../campaigns');

const router = express.Router();

// Reading one campaign you belong to still hands over the full record: you are
// a member, so its membership is not a secret from you.
const withRole = (campaign, actor) => ({ ...campaign, myRole: roleIn(campaign, actor) });

// The directory. Every campaign, summarised — never the membership itself.
router.get('/', requireUser, async (req, res, next) => {
  try {
    const all = await store.list(CAMPAIGNS);
    res.json(all.map((c) => publicSummary(c, req.actor)));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireUser, async (req, res, next) => {
  try {
    const campaign = await store.get(CAMPAIGNS, req.params.id);
    // Not a member reads as not a campaign: the existence of someone else's
    // table isn't yours to learn.
    if (!campaign || !isMember(campaign, req.actor)) {
      return res.status(404).json({ error: 'No such campaign' });
    }
    res.json(withRole(campaign, req.actor));
  } catch (err) {
    next(err);
  }
});

// Members with names attached, for the DM's member list and for labelling
// tokens. Any member may read it — you can see who else is at your table.
router.get('/:id/members', requireUser, async (req, res, next) => {
  try {
    const campaign = await store.get(CAMPAIGNS, req.params.id);
    if (!campaign || !isMember(campaign, req.actor)) {
      return res.status(404).json({ error: 'No such campaign' });
    }
    const users = await store.list(USERS);
    const members = Object.entries(campaign.members || {})
      .map(([userId, role]) => {
        const user = users.find((u) => u.id === userId);
        return user ? { ...publicUser(user), role } : null;
      })
      .filter(Boolean);
    res.json(members);
  } catch (err) {
    next(err);
  }
});

router.post('/', requireUser, async (req, res, next) => {
  try {
    const record = await store.create(CAMPAIGNS, {
      ...sanitizeCampaign(req.body),
      // You run what you start. Taken from the credential, never the body —
      // otherwise creating a campaign could name someone else as its DM.
      members: { [req.actor.userId]: 'dm' },
    });
    res.status(201).json(publicSummary(record, req.actor));
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requireUser, async (req, res, next) => {
  try {
    let denied = false;
    const record = await store.mutate(CAMPAIGNS, req.params.id, (current) => {
      if (!isDm(current, req.actor)) {
        denied = true;
        return null;
      }
      // members is not taken from the body — it has its own endpoint, so
      // renaming a campaign can't quietly rewrite who's in it.
      return { ...current, ...sanitizeCampaign(req.body) };
    });
    if (!record) {
      return denied
        ? res.status(403).json({ error: 'Only this campaign’s DM can rename it.' })
        : res.status(404).json({ error: 'No such campaign' });
    }
    for (const userId of Object.keys(record.members || {})) {
      notifyUser(req, userId, 'campaigns:changed', { action: 'update', id: record.id });
    }
    res.json(publicSummary(record, req.actor));
  } catch (err) {
    next(err);
  }
});

/**
 * Set who is at this table and what they are.
 *
 * A DM cannot demote or remove themselves if they'd be the last one: a campaign
 * with no DM is a campaign nobody can ever administer again, and there's no
 * higher authority to appeal to — admin has no standing here by design.
 */
router.put('/:id/members', requireUser, async (req, res, next) => {
  try {
    let denied = false;
    let lastDm = false;
    let before = {};

    const record = await store.mutate(CAMPAIGNS, req.params.id, (current) => {
      if (!isDm(current, req.actor)) {
        denied = true;
        return null;
      }
      const members = sanitizeMembers(req.body?.members);
      if (!Object.values(members).includes('dm')) {
        lastDm = true;
        return null;
      }
      before = current.members || {};
      return { ...current, members };
    });

    if (!record) {
      if (denied) return res.status(403).json({ error: 'Only this campaign’s DM can do that.' });
      if (lastDm) {
        return res.status(400).json({ error: 'A campaign needs at least one DM.' });
      }
      return res.status(404).json({ error: 'No such campaign' });
    }

    // Everyone who was in it or is in it now: those added need it to appear,
    // those removed need it to disappear.
    const touched = new Set([...Object.keys(before), ...Object.keys(record.members)]);
    for (const userId of touched) {
      notifyUser(req, userId, 'campaigns:changed', { action: 'members', id: record.id });
    }
    res.json(publicSummary(record, req.actor));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireUser, async (req, res, next) => {
  try {
    const campaign = await store.get(CAMPAIGNS, req.params.id);
    if (!campaign || !isMember(campaign, req.actor)) {
      return res.status(404).json({ error: 'No such campaign' });
    }
    if (!isDm(campaign, req.actor)) {
      return res.status(403).json({ error: 'Only this campaign’s DM can delete it.' });
    }
    await store.remove(CAMPAIGNS, req.params.id);
    // Record first, then files: this order leaves orphaned files if it fails
    // half way, rather than a campaign you can open but whose data is gone.
    await removeCampaignData(req.params.id);
    for (const userId of Object.keys(campaign.members || {})) {
      notifyUser(req, userId, 'campaigns:changed', { action: 'delete', id: req.params.id });
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
