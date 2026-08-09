import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  getGmPassword,
  getPlayerKey,
  setGmPassword,
  setPlayerKey,
  setSession,
  setCampaign,
} from './api.js';
import { socket, reauthenticate, enterCampaign } from './socket.js';
import Tabletop from './Tabletop.jsx';
import CharacterSheets from './CharacterSheets.jsx';
import Roster from './Roster.jsx';
import Campaigns from './Campaigns.jsx';
import Notes from './Notes.jsx';
import Music from './Music.jsx';
import MusicPlayer from './MusicPlayer.jsx';
import Chat from './Chat.jsx';
import Auth from './Auth.jsx';

// Note: an invite link's ?key=… is claimed inside api.js at import time, which
// is early enough for the socket handshake to carry it.

const ANON = { globalRole: 'anon', userId: null, name: '' };

export default function App() {
  const [actor, setActor] = useState(ANON);
  const [campaigns, setCampaigns] = useState([]);
  // Always starts closed. Reopening the last campaign automatically would put
  // you inside a table on arrival, and the directory — the thing you're meant
  // to land on — is reached by a tab that only exists while you're outside one.
  const [campaignId, setCampaignIdState] = useState('');
  // Mirrors campaignId so callbacks can read the current table without taking
  // it as a dependency and being rebuilt (and re-firing) on every switch.
  const campaignRef = useRef(campaignId);
  const [members, setMembers] = useState([]);
  const [connected, setConnected] = useState(false);
  // reachable === could we talk to the API on the last try. Drives read-only.
  const [reachable, setReachable] = useState(true);
  const [lastSynced, setLastSynced] = useState('');
  // Whether we've heard back about who we are even once. Without it the sign-in
  // screen flashes on every load before the answer arrives.
  const [ready, setReady] = useState(false);
  // The campaign directory is the front door — you choose a table before you
  // can be at one.
  const [tab, setTab] = useState('campaigns');

  const offline = !reachable;
  const authed = actor.globalRole !== 'anon';
  const isAdmin = actor.globalRole === 'admin';

  const campaign = campaigns.find((c) => c.id === campaignId) || null;
  // Your role is a property of the table, not of you. Outside a campaign you
  // have no role at all, which is why every tab below is gated on having one.
  const role = campaign?.myRole || null;
  const isDm = role === 'dm';

  /**
   * Point the whole app at a campaign: the API prefixes its URLs with it, the
   * socket joins that table's broadcasts, and the tab components are remounted
   * (see the `key` below) so none of them can render another campaign's data
   * while their own is still loading.
   */
  const openCampaign = useCallback((id) => {
    const next = id || '';
    campaignRef.current = next;
    setCampaignIdState(next);
    setCampaign(next);
    enterCampaign(next);
  }, []);

  const loadIdentity = useCallback(async () => {
    try {
      const status = await api.status();
      setActor(status.actor || ANON);
      setReachable(true);
    } catch {
      // Your PC is off — fall back to whatever the cache holds, read-only.
      setReachable(false);
    } finally {
      setReady(true);
    }
  }, []);

  const loadCampaigns = useCallback(async () => {
    try {
      const list = await api.listCampaigns();
      setCampaigns(list);
      // The campaign you have open may have been deleted, or you may have been
      // removed from it — either way, don't sit at a table that isn't there.
      // Read the current id from a ref rather than state so this callback can
      // stay dependency-free without going stale.
      const current = campaignRef.current;
      const stillMine = list.some((c) => c.id === current && c.myRole);
      if (!stillMine && current) openCampaign('');
    } catch {
      setCampaigns([]);
    }
  }, [openCampaign]);

  const loadMembers = useCallback(async (id) => {
    if (!id) return setMembers([]);
    try {
      setMembers(await api.listMembers(id));
    } catch {
      setMembers([]);
    }
  }, []);

  useEffect(() => {
    loadIdentity();
  }, [loadIdentity]);

  useEffect(() => {
    if (authed) loadCampaigns();
    else setCampaigns([]);
  }, [authed, loadCampaigns]);

  useEffect(() => {
    loadMembers(campaignId);
  }, [campaignId, loadMembers]);

  useEffect(() => {
    const onConnect = () => {
      setConnected(true);
      setReachable(true);
      loadIdentity();
      loadCampaigns();
    };
    const onDisconnect = () => {
      setConnected(false);
      setReachable(false);
    };
    const onCampaigns = () => {
      loadCampaigns();
      loadMembers(campaignId);
    };
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('campaigns:changed', onCampaigns);
    // Your key was rotated or revoked — re-ask who you are rather than carrying
    // on as someone the server no longer recognises.
    socket.on('identity:changed', loadIdentity);
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('campaigns:changed', onCampaigns);
      socket.off('identity:changed', loadIdentity);
    };
  }, [loadIdentity, loadCampaigns, loadMembers, campaignId]);

  // Changing a credential changes who we are, and the socket's identity is
  // fixed at handshake — so reconnect it too, or dragging would stay forbidden
  // until a manual refresh.
  function signedIn({ token, actor: who }) {
    setSession(token);
    setActor(who);
    reauthenticate();
  }

  async function signOut() {
    // Server-side first, so the token stops working rather than merely being
    // forgotten here. Failing that (offline), still clear this browser.
    await api.logout().catch(() => {});
    setSession('');
    // The pre-login credentials go too, or an old invite key in this browser
    // would quietly sign you straight back in as somebody.
    setGmPassword('');
    setPlayerKey('');
    openCampaign(null);
    setActor(ANON);
    setTab('campaigns');
    reauthenticate();
    loadIdentity();
  }

  const roleLabel = !authed
    ? 'Spectator'
    : role
      ? `${actor.name} · ${role.toUpperCase()}`
      : actor.name;

  /**
   * Are we at a table?
   *
   * Everything below the directory — the tabletop, the characters, the notes,
   * the chat — is one campaign's data, so none of it exists as a view until a
   * campaign is open. Not disabled, not empty: absent.
   */
  const insideCampaign = Boolean(campaignId && role);

  // Only campaigns you can actually walk into belong in the switcher. The list
  // itself is the whole server's directory now, and offering to "switch" to a
  // table you aren't at would just bounce you straight back out.
  const myCampaigns = campaigns.filter((c) => c.myRole);

  /**
   * The tab we actually render, which is not always the one last clicked: a
   * campaign can close under you (you leave it, the DM removes you, the key is
   * rotated) while you're sitting on one of its tabs. Deriving it here rather
   * than correcting it in an effect means there's no frame where a stale tab is
   * still on screen with nothing in it.
   */
  const tableTabs = ['tabletop', 'sheets', 'notes', 'music'];
  const shellTabs = ['campaigns', 'people'];

  function resolveTab(wanted) {
    if (!insideCampaign) return tableTabs.includes(wanted) ? 'campaigns' : wanted;
    if (shellTabs.includes(wanted)) return 'tabletop';
    // Music is the DM's alone — for everyone else the soundtrack is scenery,
    // and a playlist they could read would name what they're only meant to
    // hear.
    if (wanted === 'music' && !isDm) return 'tabletop';
    return wanted;
  }
  const activeTab = resolveTab(tab);

  // Don't decide anything until the server has said who we are.
  if (!ready) return <div className="auth" />;

  /**
   * No identity, no app.
   *
   * Every campaign endpoint requires one, so there is nothing behind this to
   * show — a sign-in screen is more honest than a shell with every tab empty.
   * Being offline is the exception: the cached read-only view is still worth
   * having, and there's no server to sign in to anyway.
   */
  if (!authed && !offline) return <Auth onSignedIn={signedIn} />;

  // `map` lets the tabletop claim the full height of the window. Only that tab
  // wants it: the text views grow with their content and are scrolled by the
  // page, which a fixed-height column would break.
  return (
    <div
      className={`app${insideCampaign ? '' : ' solo'}${
        insideCampaign && activeTab === 'tabletop' ? ' map' : ''
      }`}
    >
      <div className="main">
        <header>
          <h1>⚔️ RPG Manager</h1>
          <span className={connected ? 'badge on' : 'badge off'}>
            {connected ? 'live' : 'offline'}
          </span>
          <span className={`badge role ${role || actor.globalRole}`}>{roleLabel}</span>
          {actor.globalRole === 'admin' && <span className="badge role gm">admin</span>}
          {campaign && <span className="campaign-name">{campaign.name}</span>}
          <div className="spacer" />
          {insideCampaign && myCampaigns.length > 1 && (
            <select
              className="campaign-switch"
              value={campaignId}
              onChange={(e) => openCampaign(e.target.value)}
            >
              {myCampaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          {/* Only outside a campaign. At a table the header is for the table,
              and leaving is a two-step move — close the campaign, then log
              out — rather than one click sitting next to the scene controls. */}
          {!insideCampaign && (
            <button className="linky" onClick={signOut}>
              Log out
            </button>
          )}
        </header>

        {offline && (
          <p className="offline-banner">
            Offline — the table's server is unreachable, so this is a read-only view of
            the last data your browser cached.
            {lastSynced && ` Last synced ${new Date(lastSynced).toLocaleString()}.`}
          </p>
        )}

        {/* With no identity there are no tabs at all, and an empty tab bar is
            just a stray rule across the page. */}
        {authed && (
        <nav className="tabs">
          {/* These three exist only while a campaign is open — they are views
              onto its data, and there is nothing for them to show without it. */}
          {insideCampaign && (
            <>
              <button
                className={activeTab === 'tabletop' ? 'active' : ''}
                onClick={() => setTab('tabletop')}
              >
                Tabletop
              </button>
              <button
                className={activeTab === 'sheets' ? 'active' : ''}
                onClick={() => setTab('sheets')}
              >
                Characters
              </button>
              <button
                className={activeTab === 'notes' ? 'active' : ''}
                onClick={() => setTab('notes')}
              >
                {isDm ? 'Notes' : 'Handouts'}
              </button>
              {isDm && (
                <button
                  className={activeTab === 'music' ? 'active' : ''}
                  onClick={() => setTab('music')}
                >
                  Music
                </button>
              )}
              <button className="linky leave" onClick={() => openCampaign(null)}>
                Close campaign
              </button>
            </>
          )}
          <div className="spacer" />
          {/* The mirror image of the three above: these belong to the shell, not
              to a table, and while you're at one the way back is Close
              campaign — not a tab that would sit alongside its own contents. */}
          {!insideCampaign && authed && (
            <button
              className={activeTab === 'campaigns' ? 'active' : ''}
              onClick={() => setTab('campaigns')}
            >
              Campaigns
            </button>
          )}
          {!insideCampaign && isAdmin && (
            <button
              className={activeTab === 'people' ? 'active' : ''}
              onClick={() => setTab('people')}
            >
              People
            </button>
          )}
        </nav>
        )}

        {activeTab === 'campaigns' && authed && (
          <Campaigns
            actor={actor}
            currentId={campaignId}
            onOpen={(id) => {
              openCampaign(id);
              if (id) setTab('tabletop');
            }}
            onChanged={loadCampaigns}
          />
        )}
        {activeTab === 'people' && isAdmin && <Roster onUsersChanged={loadCampaigns} />}

        {/* key={campaignId} throws away every bit of state when the campaign
            changes, so a view can't briefly show the previous table's data
            while its own is still in flight. */}
        {insideCampaign && activeTab === 'tabletop' && (
          <Tabletop
            key={campaignId}
            actor={{ ...actor, role }}
            players={members}
            offline={offline}
          />
        )}
        {insideCampaign && activeTab === 'sheets' && (
          <CharacterSheets
            key={campaignId}
            actor={{ ...actor, role }}
            players={members}
            offline={offline}
            campaignId={campaignId}
            onOfflineData={setLastSynced}
          />
        )}
        {insideCampaign && activeTab === 'notes' && (
          <Notes
            key={campaignId}
            canEdit={isDm}
            offline={offline}
            campaignId={campaignId}
            onOfflineData={setLastSynced}
          />
        )}
        {insideCampaign && activeTab === 'music' && isDm && (
          <Music key={campaignId} canControl={isDm} offline={offline} />
        )}
      </div>

      {/* Outside .main so it stays put while you switch tabs. The music player
          is here for a stronger reason than the chat: inside a tab it would be
          unmounted on every tab switch, and an unmounted player is silence. */}
      {insideCampaign && (
        <div className="sidebar">
          <Chat key={campaignId} actor={{ ...actor, role }} offline={offline} />
          <MusicPlayer key={`music-${campaignId}`} canControl={isDm} />
        </div>
      )}
    </div>
  );
}
