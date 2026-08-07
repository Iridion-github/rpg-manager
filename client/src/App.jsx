import { useCallback, useEffect, useState } from 'react';
import { api, getGmPassword, getPlayerKey, setGmPassword, setPlayerKey } from './api.js';
import { socket, reauthenticate } from './socket.js';
import Tabletop from './Tabletop.jsx';
import CharacterSheets from './CharacterSheets.jsx';
import Roster from './Roster.jsx';

// Note: an invite link's ?key=… is claimed inside api.js at import time, which
// is early enough for the socket handshake to carry it.

const ANON = { role: 'anon', playerId: null, name: '' };

export default function App() {
  const [actor, setActor] = useState(ANON);
  const [players, setPlayers] = useState([]);
  const [connected, setConnected] = useState(false);
  // reachable === could we talk to the API on the last try. Drives read-only.
  const [reachable, setReachable] = useState(true);
  const [lastSynced, setLastSynced] = useState('');
  const [tab, setTab] = useState('tabletop');
  const [gmPw, setGmPw] = useState(getGmPassword());
  const [showGmBox, setShowGmBox] = useState(false);

  const offline = !reachable;
  const isGm = actor.role === 'gm';

  const loadIdentity = useCallback(async () => {
    try {
      const status = await api.status();
      setActor(status.actor || ANON);
      setReachable(true);
    } catch {
      // Your PC is off — fall back to whatever the cache holds, read-only.
      setReachable(false);
    }
  }, []);

  const loadPlayers = useCallback(async () => {
    try {
      setPlayers(await api.listPlayers());
    } catch {
      /* offline; the shell already says so */
    }
  }, []);

  useEffect(() => {
    loadIdentity();
    loadPlayers();
  }, [loadIdentity, loadPlayers]);

  useEffect(() => {
    const onConnect = () => {
      setConnected(true);
      setReachable(true);
      loadIdentity();
      loadPlayers();
    };
    const onDisconnect = () => {
      setConnected(false);
      setReachable(false);
    };
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('players:changed', loadPlayers);
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('players:changed', loadPlayers);
    };
  }, [loadIdentity, loadPlayers]);

  // Changing a credential changes our role, and the socket's role is fixed at
  // handshake — so reconnect it too, or dragging would stay forbidden until a
  // manual refresh.
  function applyGmPassword() {
    setGmPassword(gmPw);
    reauthenticate();
    loadIdentity();
    setShowGmBox(false);
  }

  function signOut() {
    setGmPassword('');
    setPlayerKey('');
    setGmPw('');
    reauthenticate();
    loadIdentity();
  }

  const roleLabel =
    actor.role === 'gm' ? 'GM' : actor.role === 'player' ? actor.name || 'Player' : 'Spectator';

  return (
    <div className="app">
      <header>
        <h1>⚔️ RPG Manager</h1>
        <span className={connected ? 'badge on' : 'badge off'}>
          {connected ? 'live' : 'offline'}
        </span>
        <span className={`badge role ${actor.role}`}>{roleLabel}</span>
        <div className="spacer" />
        {(getGmPassword() || getPlayerKey()) && (
          <button className="linky" onClick={signOut}>
            Sign out
          </button>
        )}
        {!isGm && (
          <button className="linky" onClick={() => setShowGmBox((v) => !v)}>
            I'm the GM
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

      {actor.role === 'anon' && !offline && (
        <p className="hint">
          You're viewing as a spectator. Ask your GM for an invite link to get a
          character and tokens you can move.
        </p>
      )}

      {showGmBox && !isGm && (
        <div className="gm-row">
          <input
            type="password"
            placeholder="GM password"
            value={gmPw}
            onChange={(e) => setGmPw(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && applyGmPassword()}
          />
          <button onClick={applyGmPassword}>Unlock</button>
        </div>
      )}

      <nav className="tabs">
        <button className={tab === 'tabletop' ? 'active' : ''} onClick={() => setTab('tabletop')}>
          Tabletop
        </button>
        <button className={tab === 'sheets' ? 'active' : ''} onClick={() => setTab('sheets')}>
          Characters
        </button>
        {isGm && (
          <button className={tab === 'players' ? 'active' : ''} onClick={() => setTab('players')}>
            Players
          </button>
        )}
      </nav>

      {tab === 'tabletop' && <Tabletop actor={actor} players={players} offline={offline} />}
      {tab === 'sheets' && (
        <CharacterSheets canEdit={isGm} offline={offline} onOfflineData={setLastSynced} />
      )}
      {tab === 'players' && isGm && <Roster onPlayersChanged={loadPlayers} />}
    </div>
  );
}
