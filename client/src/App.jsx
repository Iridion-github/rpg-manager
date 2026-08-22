import { useCallback, useEffect, useRef, useState } from 'react';
import { api, setGmPassword, setSession, setCampaign } from './api.js';
import { socket, reauthenticate, enterCampaign } from './socket.js';
import { clear as clearHistory } from './history.js';
import { formatDateTime } from './dateFormat.js';
import Tabletop from './Tabletop.jsx';
import Account from './Account.jsx';
import Avatar from './Avatar.jsx';
import ConfirmChange from './ConfirmChange.jsx';
import CharacterSheets from './CharacterSheets.jsx';
import MyCharacters from './MyCharacters.jsx';
import Roster from './Roster.jsx';
import Campaigns from './Campaigns.jsx';
import Notes from './Notes.jsx';
import Players from './Players.jsx';
import Tokens from './Tokens.jsx';
import Items from './Items.jsx';
import Music from './Music.jsx';
import MusicPlayer from './MusicPlayer.jsx';
import Chat from './Chat.jsx';
import Auth from './Auth.jsx';
import ResetPassword from './ResetPassword.jsx';
import PatchNotes from './PatchNotes.jsx';

const ANON = { globalRole: 'anon', userId: null, name: '' };

/**
 * Read a token out of the address bar, and take it out of the address bar.
 *
 * The same care api.js takes with the old invite key, and for the same reasons:
 * a credential in a URL is one a reload spends twice, and one that ends up in
 * bookmarks, in history and in whatever screenshot gets pasted into chat when
 * somebody asks why the page looks odd. It lives in React state for the life of
 * the tab instead, which is exactly as long as it is needed.
 */
function takeToken(param) {
  const url = new URL(window.location.href);
  const token = url.searchParams.get(param);
  if (!token) return '';
  url.searchParams.delete(param);
  window.history.replaceState({}, '', url.pathname + url.search + url.hash);
  return token;
}

export default function App() {
  const [actor, setActor] = useState(ANON);
  const [campaigns, setCampaigns] = useState([]);
  // Always starts closed. Reopening the last campaign automatically would put
  // you inside a table on arrival, and the directory - the thing you're meant
  // to land on - is reached by a tab that only exists while you're outside one.
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
  // The campaign directory is the front door - you choose a table before you
  // can be at one.
  const [tab, setTab] = useState('campaigns');
  // What this server offers an account screen: a signup code to type instead of
  // answering a letter, and whether it can send one at all.
  const [authConfig, setAuthConfig] = useState({});
  // A confirmation token from a link in an email: the answer to a change this
  // account already asked for.
  const [confirmToken, setConfirmToken] = useState(() => takeToken('confirm'));
  /**
   * The other half of the same idea: a reset link, which opens a form rather
   * than a yes/no. Two parameters instead of one flag, so the page knows which
   * of the two it is without having to ask the server - and so presenting one
   * at the other's route, which would waste the token, can't happen by accident.
   */
  const [resetToken, setResetToken] = useState(() => takeToken('reset'));

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
    // What you did at the last table isn't yours to undo at this one - the
    // entries name scenes and tokens that don't exist here.
    clearHistory();
  }, []);

  const loadIdentity = useCallback(async () => {
    try {
      const status = await api.status();
      setActor(status.actor || ANON);
      setReachable(true);
    } catch {
      // Your PC is off - fall back to whatever the cache holds, read-only.
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
      // removed from it - either way, don't sit at a table that isn't there.
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

  // Read once: what a server offers an account is set when it starts, not while
  // it runs. A failure leaves the empty object, and the account screen then
  // offers the safest reading of it - no code, no mail.
  useEffect(() => {
    api.authConfig().then(setAuthConfig).catch(() => { });
  }, []);

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
    /**
     * A dropped socket is a reason to *ask* whether the server is there, not an
     * answer in itself.
     *
     * The two are different questions and they used to share a flag. A busy
     * connection - a tunnel carrying a few hundred token thumbnails - starves
     * the WebSocket's heartbeat long before it troubles an HTTP request, and
     * calling that "unreachable" emptied the whole app into its read-only cache
     * while every request was still going through perfectly well.
     *
     * So: live updates have stopped, say so, and go and find out about the rest.
     * `loadIdentity` is one small GET that answers it honestly - it sets
     * reachable either way, so a server that really has gone still lands in the
     * cached view a moment later.
     */
    const onDisconnect = () => {
      setConnected(false);
      loadIdentity();
    };
    const onCampaigns = () => {
      loadCampaigns();
      loadMembers(campaignId);
    };
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('campaigns:changed', onCampaigns);
    // Your key was rotated or revoked - re-ask who you are rather than carrying
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
  // fixed at handshake - so reconnect it too, or dragging would stay forbidden
  // until a manual refresh.
  function signedIn({ token, actor: who }) {
    setSession(token);
    setActor(who);
    reauthenticate();
  }

  async function signOut() {
    // Server-side first, so the token stops working rather than merely being
    // forgotten here. Failing that (offline), still clear this browser.
    await api.logout().catch(() => { });
    setSession('');
    // The admin password goes too, or a browser holding it would quietly sign
    // you straight back in as the admin.
    setGmPassword('');
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
   * Everything below the directory - the tabletop, the characters, the notes,
   * the chat - is one campaign's data, so none of it exists as a view until a
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
  const tableTabs = ['tabletop', 'sheets', 'notes', 'music', 'tokens', 'items', 'players'];
  const shellTabs = ['campaigns', 'characters', 'users', 'patch', 'account'];

  function resolveTab(wanted) {
    if (!insideCampaign) return tableTabs.includes(wanted) ? 'campaigns' : wanted;
    if (shellTabs.includes(wanted)) return 'tabletop';
    // Music is the DM's alone - for everyone else the soundtrack is scenery,
    // and a playlist they could read would name what they're only meant to
    // hear.
    if (wanted === 'music' && !isDm) return 'tabletop';
    return wanted;
  }
  const activeTab = resolveTab(tab);

  // Don't decide anything until the server has said who we are.
  if (!ready) return <div className="auth" />;

  /**
   * A link from a confirmation email takes over the whole window.
   *
   * Before the sign-in check, because the token is the authorisation and the
   * mail may well have been opened in a browser that has never signed in here.
   * Finishing it reloads the identity: a confirmed password change has just
   * signed this session out, and a confirmed address change means /me now says
   * something different.
   */
  if (confirmToken) {
    return (
      <ConfirmChange
        token={confirmToken}
        onDone={() => {
          setConfirmToken('');
          loadIdentity();
        }}
      />
    );
  }

  /**
   * A reset link, likewise, and ahead of the sign-in screen for a blunter
   * reason than its sibling: the person holding this one cannot sign in, so a
   * door asking them to would be the door they are standing here about.
   *
   * Finishing reloads the identity too. The reset signed out every session on
   * that account - including, if the mail happened to be read in this browser,
   * the one this tab is holding - so what /me says afterwards is a question
   * worth asking again rather than assuming.
   */
  if (resetToken) {
    return (
      <ResetPassword
        token={resetToken}
        onDone={() => {
          setResetToken('');
          loadIdentity();
        }}
      />
    );
  }

  /**
   * No identity, no app.
   *
   * Every campaign endpoint requires one, so there is nothing behind this to
   * show - a sign-in screen is more honest than a shell with every tab empty.
   * Being offline is the exception: the cached read-only view is still worth
   * having, and there's no server to sign in to anyway.
   */
  if (!authed && !offline) return <Auth onSignedIn={signedIn} />;

  // `map` lets the tabletop claim the full height of the window. Only that tab
  // wants it: the text views grow with their content and are scrolled by the
  // page, which a fixed-height column would break.
  return (
    <div
      className={`app${insideCampaign ? '' : ' solo'}${insideCampaign && activeTab === 'tabletop' ? ' map' : ''
        }`}
    >
      <div className="main">
        {/* Identity and navigation on one line. They were stacked, which cost
            the map two rows of chrome to say two short things - and the map is
            the one view that wants every pixel. Wraps back to two lines when
            the window is too narrow to hold both, which is no worse than what
            it always did. */}
        <div className="topbar">
          <header>
            <h1>⚔️ RPG Manager</h1>
            {/* A dot rather than a word. This is a green "fine" almost always,
              and the state that actually matters - not connected - already
              gets a full-width banner under the bar. The colour carries it;
              the tooltip spells it out for anyone who wants it. */}
            <span
              className={`live-dot${connected ? ' on' : ''}`}
              role="status"
              aria-label={connected ? 'Connected to the table' : 'Not connected to the table'}
              title={
                connected
                  ? 'Connected'
                  : 'Not connected'
              }
            />
            {/* Your own picture, beside the name it belongs to. Only once there
                is somebody to have one: a spectator has no account and so no
                face to draw. */}
            {authed && <Avatar url={actor.avatarUrl} name={actor.name} />}
            <span className={`badge role ${role || actor.globalRole}`}>{roleLabel}</span>
            {actor.globalRole === 'admin' && <span className="badge role gm">admin</span>}
            {campaign && <span className="campaign-name"><b>{campaign.name}</b></span>}
          </header>

          {/* With no identity there are no tabs at all, and an empty tab bar is
            just a stray rule across the page. */}
          {authed && (
            <nav className="tabs">
              {/* These three exist only while a campaign is open - they are views
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
                  {/* Everyone: knowing what artwork exists is not the DM's secret,
                  and a player who has browsed it can ask for the right goblin
                  by name. */}
                  <button
                    className={activeTab === 'tokens' ? 'active' : ''}
                    onClick={() => setTab('tokens')}
                  >
                    Tokens
                  </button>
                  {/* The reference shelves rather than anything belonging to
                  this table, so everybody gets them: looking up what a shield
                  costs is not a thing the DM should have to be asked for. */}
                  <button
                    className={activeTab === 'items' ? 'active' : ''}
                    onClick={() => setTab('items')}
                  >
                    Compendia
                  </button>
                  {/* Last, and for everyone: who is at this table is not the DM's
                  private information - the members endpoint has always been
                  readable by any member. */}
                  <button
                    className={activeTab === 'players' ? 'active' : ''}
                    onClick={() => setTab('players')}
                  >
                    Players
                  </button>
                  <button className="linky leave" onClick={() => openCampaign(null)}>
                    Close campaign
                  </button>
                </>
              )}
              <div className="spacer" />
              {/* The mirror image of the three above: these belong to the shell, not
              to a table, and while you're at one the way back is Close
              campaign - not a tab that would sit alongside its own contents. */}
              {!insideCampaign && authed && (
                <button
                  className={activeTab === 'campaigns' ? 'active' : ''}
                  onClick={() => setTab('campaigns')}
                >
                  Campaigns
                </button>
              )}
              {/* Straight after the directory, because it is the other half of
              the same question: those are your tables, and these are your
              characters. Your own shelf rather than a view onto the tables' -
              a character gets here by being copied off a campaign sheet, and
              the copy is nobody else's and moves with neither. See
              MyCharacters.jsx. */}
              {!insideCampaign && authed && (
                <button
                  className={activeTab === 'characters' ? 'active' : ''}
                  onClick={() => setTab('characters')}
                >
                  My Characters
                </button>
              )}
              {/* Everyone signed in can see who else is here - a DM picking members
              is reading this same list from inside their campaign. What you can
              *do* to it is another matter, and the tab itself decides that. */}
              {!insideCampaign && authed && (
                <button
                  className={activeTab === 'users' ? 'active' : ''}
                  onClick={() => setTab('users')}
                >
                  Users
                </button>
              )}
              {/* Before My account, which is where a list of "what's new here"
              belongs: the tabs to its left are places to go and do something,
              and this is the one that says what has changed since you last
              did. Shown to anyone signed in - it describes the app, and every
              signed-in person is using the same one. */}
              {!insideCampaign && authed && (
                <button
                  className={activeTab === 'patch' ? 'active' : ''}
                  onClick={() => setTab('patch')}
                >
                  Patch notes
                </button>
              )}
              {/* Last, and unlike the rest, for everybody: this one is about the
              person signed in rather than about the server. */}
              {!insideCampaign && authed && (
                <button
                  className={activeTab === 'account' ? 'active' : ''}
                  onClick={() => setTab('account')}
                >
                  My account
                </button>
              )}
            </nav>
          )}

          {/* End of the bar: the spacer pushes these right, past the tabs. They
            were inside the header when the header owned its own row; on a
            shared row they belong to the row. */}
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
          {/* Only outside a campaign. At a table, leaving is a two-step move -
            close the campaign, then log out - rather than one click sitting
            next to the scene controls. */}
          {!insideCampaign && (
            <button className="linky" onClick={signOut}>
              Log out
            </button>
          )}
        </div>

        {/* Its own block under the bar rather than a item in it: it is a
            paragraph, and squeezing it between the tabs and the switcher would
            leave room for about three words of it. */}
        {offline && (
          <p className="offline-banner">
            Offline - the table's server is unreachable, so this is a read-only view of
            the last data your browser cached.
            {lastSynced && ` Last synced ${formatDateTime(lastSynced)}.`}
          </p>
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
        {/* Mounted for as long as you are outside a campaign, not just for its
            tab - the same arrangement as the sheets inside one, and for the
            same reason: an open character floats over the app in a window of
            its own, and it should survive a look at the campaign list. Walking
            into a campaign unmounts this, which is what shuts those windows. */}
        {!insideCampaign && authed && (
          <MyCharacters
            offline={offline}
            onOfflineData={setLastSynced}
            showRoster={activeTab === 'characters'}
          />
        )}
        {activeTab === 'users' && authed && (
          <Roster isAdmin={isAdmin} onUsersChanged={loadCampaigns} />
        )}
        {/* Nothing is passed to it and nothing is fetched: the list ships with
            the app, so it always describes the version being looked at. It also
            means this page works with the server unreachable, which is the one
            time somebody might reasonably wonder what changed. */}
        {activeTab === 'patch' && authed && <PatchNotes />}
        {activeTab === 'account' && authed && (
          <Account
            actor={actor}
            config={authConfig}
            offline={offline}
            // A new shown name is what every other screen calls you, so the
            // identity behind them has to be re-read rather than left saying
            // the old one until the next reload.
            onChanged={loadIdentity}
          />
        )}

        {/* The campaign id in each key throws away every bit of state when the
            campaign changes, so a view can't briefly show the previous table's
            data while its own is still in flight.

            Each is prefixed with its own name because two of these views can be
            mounted at once (the characters one outlives its tab, below) and two
            siblings sharing a key makes React duplicate and drop nodes rather
            than reconcile them. Same reason the sidebar's player is keyed
            `music-…`. Keep the prefixes even where a view is currently
            exclusive - the next one to escape its tab shouldn't have to
            rediscover this. */}
        {insideCampaign && activeTab === 'tabletop' && (
          <Tabletop
            key={`tabletop-${campaignId}`}
            actor={{ ...actor, role }}
            players={members}
            offline={offline}
          />
        )}
        {/* Mounted for the whole campaign, not just its tab. An open character
            sheet floats over the app in a window of its own, and you're meant
            to be able to read it while looking at the map - so the tab only
            decides whether the *roster* is on screen. Closing the campaign
            unmounts this, which is what shuts an open sheet. */}
        {insideCampaign && (
          <CharacterSheets
            key={`sheets-${campaignId}`}
            actor={{ ...actor, role }}
            players={members}
            offline={offline}
            campaignId={campaignId}
            campaignName={campaign?.name || ''}
            onOfflineData={setLastSynced}
            showRoster={activeTab === 'sheets'}
          />
        )}
        {/* Mounted for the whole campaign for the same reason as the sheets: a
            note popped out into a window floats over the app, and closing the
            campaign - not switching tabs - is what takes it away. */}
        {insideCampaign && (
          <Notes
            key={`notes-${campaignId}`}
            actor={{ ...actor, role }}
            // Who a note can be handed to, and the names to hand it to them by.
            players={members}
            canEdit={isDm}
            offline={offline}
            campaignId={campaignId}
            onOfflineData={setLastSynced}
            showList={activeTab === 'notes'}
          />
        )}
        {insideCampaign && activeTab === 'music' && isDm && (
          <Music key={`music-${campaignId}`} canControl={isDm} offline={offline} />
        )}
        {insideCampaign && activeTab === 'tokens' && (
          <Tokens
            key={`tokens-${campaignId}`}
            actor={actor}
            players={members}
            isDm={isDm}
            offline={offline}
          />
        )}
        {/* Keyed by campaign like the rest, though it holds nothing of the
            campaign's: it costs nothing and means the next table starts on the
            categories rather than on whatever the last one was reading. */}
        {insideCampaign && activeTab === 'items' && <Items key={`items-${campaignId}`} />}
        {insideCampaign && activeTab === 'players' && (
          <Players
            key={`players-${campaignId}`}
            campaignId={campaignId}
            actor={actor}
            isDm={isDm}
            offline={offline}
          />
        )}
      </div>

      {/* Outside .main so it stays put while you switch tabs. The music player
          is here for a stronger reason than the chat: inside a tab it would be
          unmounted on every tab switch, and an unmounted player is silence. */}
      {insideCampaign && (
        <div className="sidebar">
          <Chat key={`chat-${campaignId}`} actor={{ ...actor, role }} offline={offline} />
          <MusicPlayer key={`music-${campaignId}`} canControl={isDm} />
        </div>
      )}
    </div>
  );
}
