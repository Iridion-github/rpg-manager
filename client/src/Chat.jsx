import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { socket } from './socket.js';
import DiceModal from './DiceModal.jsx';

// Treat "within this many pixels of the bottom" as following the conversation.
const STICK_PX = 40;

const time = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export default function Chat({ actor, offline }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [diceOpen, setDiceOpen] = useState(false);
  // The message a right-click menu is open on: { id, clientX, clientY }.
  const [menu, setMenu] = useState(null);

  const listRef = useRef(null);
  const menuRef = useRef(null);
  // Whether to auto-scroll after the next render. We only follow along if the
  // reader was already at the bottom - yanking someone back down while they're
  // reading history is worse than missing a line.
  const stickRef = useRef(true);

  const canPost = !offline && (actor?.role === 'dm' || actor?.role === 'player');

  /**
   * Whose line is this to remove?
   *
   * Your own, or anybody's if you're the DM - the same rule the server enforces
   * (see routes/chat.js), asked here only so a menu isn't offered for something
   * that would be refused. A line posted before authorship was recorded belongs
   * to nobody, so only the DM is offered it.
   */
  const canDelete = useCallback(
    (m) =>
      !offline &&
      (actor?.role === 'dm' || Boolean(m.authorId && actor?.userId && m.authorId === actor.userId)),
    [offline, actor?.role, actor?.userId]
  );

  const load = useCallback(async () => {
    try {
      setMessages(await api.listChat());
      stickRef.current = true;
      setError('');
    } catch {
      /* offline; the shell already says so */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const onMessage = ({ message }) => {
      if (!message?.id) return;
      // Our own echo is welcome here: appending is keyed on the message id, so
      // a duplicate is discarded anyway. Skipping by origin would lose rolls
      // made elsewhere in this tab - from a character sheet, say - which never
      // pass through this component to be appended optimistically.
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
    };
    // Somebody took a line back. Our own echo included - dropping it twice is
    // the same list either way, and the person who did it may be reading this
    // table in a second tab.
    const onDeleted = ({ id }) => {
      if (!id) return;
      setMessages((prev) => prev.filter((m) => m.id !== id));
      setMenu((open) => (open?.id === id ? null : open));
    };
    socket.on('chat:message', onMessage);
    socket.on('chat:deleted', onDeleted);
    socket.on('connect', load); // reconnected → we may have missed lines
    return () => {
      socket.off('chat:message', onMessage);
      socket.off('chat:deleted', onDeleted);
      socket.off('connect', load);
    };
  }, [load]);

  // An open menu is dismissed by anything that isn't using it - the same rule
  // the map's and the player list's right-click menus follow. The log scrolling
  // counts: the menu is pinned to the screen, not to the message under it.
  useEffect(() => {
    if (!menu) return;
    const close = (e) => {
      if (e?.target && menuRef.current?.contains(e.target)) return;
      setMenu(null);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', close, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', close);
    };
  }, [menu]);

  // Record whether we're following *before* the DOM changes height.
  function onScroll() {
    const el = listRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
  }

  useLayoutEffect(() => {
    if (!stickRef.current) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function send(e) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || sending || !canPost) return;
    setSending(true);
    try {
      const message = await api.sendChat(text);
      setDraft('');
      stickRef.current = true; // saying something always scrolls you down
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  // The server rolls and appends, exactly like sending a line of text.
  async function rollDice(spec) {
    const message = await api.rollDice(spec);
    stickRef.current = true;
    setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
  }

  /**
   * Take a line back out of the log.
   *
   * Removed here as well as by the broadcast that follows, so it goes the
   * moment the server agrees rather than a round trip later. A refusal leaves
   * the message where it is and says why - the server is the one that decides,
   * and the menu offering this is only a guess at what it will say.
   */
  async function removeMessage(id) {
    setMenu(null);
    try {
      await api.deleteChat(id);
      setMessages((prev) => prev.filter((m) => m.id !== id));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <aside className="chat">
      <h2>Chat</h2>

      <div className="chat-log" ref={listRef} onScroll={onScroll}>
        {messages.map((m) => (
          <div
            key={m.id}
            className={`chat-msg${m.role === 'dm' ? ' from-gm' : ''}${m.secret ? ' secret' : ''}`}
            // No menu on a line you can't do anything to: the browser's own
            // right-click menu is more use there than an empty one of ours.
            onContextMenu={(e) => {
              if (!canDelete(m)) return;
              e.preventDefault();
              setMenu({ id: m.id, clientX: e.clientX, clientY: e.clientY });
            }}
          >
            <div className="chat-meta">
              <strong>{m.author}</strong>
              <span>{time(m.at)}</span>
              {/* Anyone reading this line is either the DM or the person who
                  rolled it - the server never sends it to anybody else. Saying
                  so is what stops it being read as a public result. */}
              {m.secret && <span className="badge secret-badge">DM only</span>}
            </div>
            {m.kind === 'roll' && m.roll ? (
              <RollResult roll={m.roll} />
            ) : m.kind === 'sheet' ? (
              <SheetExcerpt title={m.title} text={m.text} />
            ) : (
              <p>{m.text}</p>
            )}
          </div>
        ))}
        {messages.length === 0 && <p className="empty">No messages yet.</p>}
      </div>

      {menu && messages.some((m) => m.id === menu.id) && (
        <div className="map-menu" ref={menuRef} style={{ left: menu.clientX, top: menu.clientY }}>
          <button className="danger" onClick={() => removeMessage(menu.id)}>
            Delete message
          </button>
        </div>
      )}

      {error && <p className="error">{error}</p>}

      {canPost ? (
        <form className="chat-send" onSubmit={send}>
          <textarea
            rows={2}
            placeholder="Say something…"
            value={draft}
            maxLength={500}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter starts a new line.
              if (e.key === 'Enter' && !e.shiftKey) send(e);
            }}
          />
          <div className="chat-buttons">
            <button type="button" onClick={() => setDiceOpen(true)}>
              🎲 Dice
            </button>
            <button type="submit" disabled={sending || !draft.trim()}>
              Send
            </button>
          </div>
        </form>
      ) : (
        <p className="hint chat-readonly">
          {offline ? 'Offline - chat is read-only.' : 'Spectators can read the chat but not post.'}
        </p>
      )}

      {diceOpen && (
        <DiceModal
          title="Roll dice"
          confirmLabel="Roll"
          onClose={() => setDiceOpen(false)}
          onConfirm={rollDice}
        />
      )}
    </aside>
  );
}

/**
 * Something somebody read off their character sheet and showed the table.
 *
 * A block with its own heading rather than another paragraph of chat: what
 * arrives here is a section - a feature and what it does, eighteen skills - and
 * the whole reason it was sent is that somebody wanted it read. The line breaks
 * it was written with are kept (the CSS preserves them), because they are the
 * formatting.
 */
function SheetExcerpt({ title, text }) {
  return (
    <div className="chat-excerpt">
      {title && <strong>{title}</strong>}
      <p>{text}</p>
    </div>
  );
}

const coinFace = (v) => (v === 1 ? 'Heads' : 'Tails');

// Shows the working, not just the answer - at a table people want to see the
// individual dice, and the per-die modifier only makes sense spelled out.
const signOf = (n) => (n > 0 ? `+${n}` : `${n}`);

// "+1d4 Bless", "+2 Rage" - a global modifier said the way the sheet says it.
function extraNote(extra) {
  const dice = extra.count ? `+${extra.count}d${extra.sides}` : '';
  const flat = extra.modifier ? signOf(extra.modifier) : '';
  return [dice, flat, extra.label].filter(Boolean).join(' ');
}

function RollResult({ roll }) {
  const { count, sides, modifier, rolls, total, advantage, disadvantage, label } = roll;
  // Which way this d20 was thrown, if either. Absent on every roll made before
  // disadvantage existed, which reads as the advantage-or-nothing it was.
  const swing = advantage ? 'advantage' : disadvantage ? 'disadvantage' : '';
  // Named things that rolled with this one and are already in its total. Absent
  // on every roll made before they existed, and on most made since.
  const extras = roll.extras || [];
  const sign = modifier > 0 ? `+${modifier}` : `${modifier}`;
  // Only one of the two dice counts; the other is shown struck through, so you
  // can see what it beat or what it escaped. The better one for advantage, the
  // worse for disadvantage.
  const winner = swing ? (advantage ? Math.max(...rolls) : Math.min(...rolls)) : null;
  let keptSeen = false;

  if (sides === 2) {
    return (
      <div className="roll">
        <span className="roll-notation">
          {count} coin{count === 1 ? '' : 's'}
        </span>
        <span className="roll-dice">
          {rolls.map((r, i) => (
            <b key={i}>{coinFace(r)}</b>
          ))}
        </span>
      </div>
    );
  }

  return (
    <div className="roll">
      <span className="roll-notation">
        {label ? `${label} · ` : ''}
        {count}d{sides}
        {modifier ? sign : ''}
        {extras.length ? ` · ${extras.map(extraNote).join(', ')}` : ''}
        {swing ? ` · ${swing}` : ''}
      </span>
      <span className="roll-dice">
        {rolls.map((r, i) => {
          // Exactly one die is kept, even when both rolled the same number.
          const dropped = swing && !(r === winner && !keptSeen);
          if (swing && r === winner && !keptSeen) keptSeen = true;
          return (
            <b
              key={i}
              className={`${dropped ? 'dropped' : r === sides ? 'max' : r === 1 ? 'min' : ''}`}
            >
              {r}
            </b>
          );
        })}
        {/* The modifier is one addition to the total, so it sits apart from
            the dice rather than on each of them. */}
        {modifier ? <em className="roll-mod">{sign}</em> : null}

        {/* Everything a global modifier contributed, tinted apart from the
            attack's own dice. Without these the working would not add up: the
            total already counts them, so a row that showed only the weapon's
            die would be a sum with a piece missing. */}
        {extras.map((e, i) => (
          <span className="roll-add" key={i} title={e.label || 'Modifier'}>
            {e.rolls.map((r, j) => (
              <b key={j} className="extra">
                {r}
              </b>
            ))}
            {e.modifier ? <em className="roll-mod">{signOf(e.modifier)}</em> : null}
          </span>
        ))}
      </span>
      <span className="roll-total">= {total}</span>
    </div>
  );
}
