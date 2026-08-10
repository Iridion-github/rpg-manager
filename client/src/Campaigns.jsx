import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import ConfirmDeleteModal from './ConfirmDeleteModal.jsx';

/**
 * The campaign directory — the first thing you see on arriving.
 *
 * Every campaign on the server is listed, yours first. What's public is that a
 * table exists and how busy it is; what stays private is *who* is at it, so the
 * list carries a member count and never a member. Seeing a campaign you're not
 * in gets you nothing else: its contents are member-only, and the server
 * enforces that rather than trusting this list to look away.
 */

const dateOnly = (iso) => {
  const d = new Date(iso || '');
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
};

// Relative time reads better than a date for "is anyone still running this?" —
// "3 days ago" answers it, "12/04/2026" makes you do the arithmetic.
function sinceNow(iso) {
  const then = Date.parse(iso || '');
  if (!then) return 'never';
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 31) return `${days}d ago`;
  return dateOnly(iso);
}

/**
 * Yours first, then everyone else's; most recently active first within each
 * group, so a live table outranks a dormant one.
 */
function ordered(campaigns) {
  const rank = (c) => (c.myRole ? 0 : 1);
  return [...campaigns].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const activity = Date.parse(b.lastActivityAt || 0) - Date.parse(a.lastActivityAt || 0);
    if (activity) return activity;
    return (a.name || '').localeCompare(b.name || '');
  });
}

export default function Campaigns({ actor, currentId, onOpen, onChanged }) {
  const [campaigns, setCampaigns] = useState([]);
  const [users, setUsers] = useState([]);
  const [members, setMembers] = useState([]); // of the campaign being edited
  const [name, setName] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(''); // campaign whose panel is open
  const [confirmDelete, setConfirmDelete] = useState('');

  const load = useCallback(async () => {
    try {
      const [list, people] = await Promise.all([api.listCampaigns(), api.listUsers()]);
      setCampaigns(list);
      setUsers(people);
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // The list never carries the members map, so the DM's editor asks for it
  // separately — an endpoint only a member of that campaign can call.
  const openEditor = useCallback(async (id) => {
    setEditing(id);
    setMembers([]);
    if (!id) return;
    try {
      setMembers(await api.listMembers(id));
    } catch (e) {
      setError(e.message);
    }
  }, []);

  async function guard(fn) {
    setBusy(true);
    try {
      await fn();
      setError('');
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const create = (e) => {
    e.preventDefault();
    return guard(async () => {
      const created = await api.createCampaign({
        name: name || 'New Campaign',
        description: subtitle,
      });
      setCampaigns((prev) => [...prev, created]);
      setName('');
      setSubtitle('');
      onOpen?.(created.id); // you almost certainly want to walk into it
    });
  };

  // From the live list, so the dialog can't outlive what it asks about.
  const confirmCampaign = campaigns.find((c) => c.id === confirmDelete) || null;

  const saveDetails = (campaign, patch) =>
    guard(async () => {
      const updated = await api.updateCampaign(campaign.id, { ...campaign, ...patch });
      setCampaigns((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    });

  // Thrown as well as shown, so the dialog stays open on a failure instead of
  // closing as though the campaign had gone.
  async function remove(id) {
    setError('');
    try {
      await api.deleteCampaign(id);
      setCampaigns((prev) => prev.filter((c) => c.id !== id));
      setConfirmDelete('');
      setEditing('');
      if (currentId === id) onOpen?.(null);
    } catch (e) {
      setError(e.message);
      throw e;
    }
  }

  const setRole = (campaign, userId, role) =>
    guard(async () => {
      const next = {};
      for (const m of members) next[m.id] = m.role;
      if (role === 'none') delete next[userId];
      else next[userId] = role;

      const updated = await api.setMembers(campaign.id, next);
      setCampaigns((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      setMembers(await api.listMembers(campaign.id));
    });

  const roleOf = (userId) => members.find((m) => m.id === userId)?.role || 'none';

  return (
    <div className="campaigns">
      <p className="hint">
        Every campaign on this server. The ones you're part of come first —
        everything else you can see the shape of, but not the contents.
      </p>

      {error && <p className="error">{error}</p>}

      <form className="new-campaign" onSubmit={create}>
        <input
          placeholder="Campaign name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          placeholder="Subtitle (optional)"
          value={subtitle}
          maxLength={200}
          onChange={(e) => setSubtitle(e.target.value)}
        />
        <button type="submit" disabled={busy}>
          + Start a campaign
        </button>
      </form>

      <div className="campaign-table" role="table">
        <div className="campaign-head" role="row">
          <span>Campaign</span>
          <span>Players</span>
          <span>Created</span>
          <span>Last activity</span>
          <span />
        </div>

        {ordered(campaigns).map((c) => {
          const mine = Boolean(c.myRole);
          const isDm = c.myRole === 'dm';
          const open = editing === c.id;
          return (
            <div
              key={c.id}
              className={`campaign-card${mine ? ' mine' : ''}${c.id === currentId ? ' current' : ''}`}
            >
              <div className="campaign-line" role="row">
                <div className="campaign-title">
                  {/* Only a member can open one; for everyone else the name is
                      text, not a promise of a door. */}
                  {mine ? (
                    <button className="campaign-open" onClick={() => onOpen?.(c.id)}>
                      {c.name}
                    </button>
                  ) : (
                    <span className="campaign-open-disabled">{c.name}</span>
                  )}
                  <div className="campaign-badges">
                    {mine && <span className={`badge role ${c.myRole}`}>{c.myRole}</span>}
                    {c.id === currentId && <span className="badge on">open</span>}
                  </div>
                  {c.description && <span className="campaign-subtitle">{c.description}</span>}
                </div>

                {/* How many, never who. */}
                <span className="campaign-count" title="How many people are at this table">
                  {c.memberCount}
                </span>
                <span className="campaign-date created">{dateOnly(c.createdAt)}</span>
                <span
                  className="campaign-date activity"
                  title={c.lastActivityAt || 'No DM has opened it yet'}
                >
                  {sinceNow(c.lastActivityAt)}
                </span>

                <div className="campaign-actions">
                  {isDm && (
                    <button onClick={() => openEditor(open ? '' : c.id)} disabled={busy}>
                      ⚙︎ Manage
                    </button>
                  )}
                </div>
              </div>

              {isDm && open && (
                <div className="access-panel">
                  <label className="campaign-rename">
                    Name
                    <input
                      defaultValue={c.name}
                      onBlur={(e) =>
                        e.target.value !== c.name && saveDetails(c, { name: e.target.value })
                      }
                    />
                  </label>
                  <label className="campaign-rename">
                    Subtitle
                    <input
                      defaultValue={c.description || ''}
                      maxLength={200}
                      placeholder="One line about this campaign"
                      onBlur={(e) =>
                        e.target.value !== (c.description || '') &&
                        saveDetails(c, { description: e.target.value })
                      }
                    />
                  </label>

                  <p className="hint">
                    A campaign always needs at least one DM, so you can't step
                    down until someone else can run it.
                  </p>
                  <ul className="access-list">
                    {users.map((u) => (
                      <li key={u.id}>
                        <span className="swatch" style={{ background: u.color }} />
                        <strong>
                          {u.name}
                          {u.id === actor?.userId ? ' (you)' : ''}
                        </strong>
                        <select
                          value={roleOf(u.id)}
                          onChange={(e) => setRole(c, u.id, e.target.value)}
                          disabled={busy}
                        >
                          <option value="none">Not at this table</option>
                          <option value="player">Player</option>
                          <option value="dm">DM</option>
                        </select>
                      </li>
                    ))}
                  </ul>
                  {users.length === 0 && (
                    <p className="empty">
                      No other people exist yet — the admin adds them in the People tab.
                    </p>
                  )}

                  <div className="campaign-danger">
                    <div className="spacer" />
                    {/* Asked in the same dialog as every other delete in the
                        app rather than by swapping this row for two buttons —
                        one place to read "is this the right thing?", and the
                        same shape of answer wherever you meet it. */}
                    <button className="del" onClick={() => setConfirmDelete(c.id)} disabled={busy}>
                      Delete campaign
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {campaigns.length === 0 && (
          <p className="empty">
            No campaigns on this server yet. Start the first one above.
          </p>
        )}
      </div>

      {/* The heaviest delete in the app — scenes, sheets, notes, chat, the lot
          — so it asks for the name in full. */}
      {confirmCampaign && (
        <ConfirmDeleteModal
          name={confirmCampaign.name}
          byName
          description="This deletes the campaign and everything in it — every scene, character sheet, note and message — for everyone at the table. It can't be undone."
          confirmLabel="Delete campaign"
          onConfirm={() => remove(confirmCampaign.id)}
          onClose={() => setConfirmDelete('')}
        />
      )}
    </div>
  );
}
