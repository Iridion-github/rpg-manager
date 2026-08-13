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

  const listRef = useRef(null);
  // Whether to auto-scroll after the next render. We only follow along if the
  // reader was already at the bottom - yanking someone back down while they're
  // reading history is worse than missing a line.
  const stickRef = useRef(true);

  const canPost = !offline && (actor?.role === 'dm' || actor?.role === 'player');

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
    socket.on('chat:message', onMessage);
    socket.on('connect', load); // reconnected → we may have missed lines
    return () => {
      socket.off('chat:message', onMessage);
      socket.off('connect', load);
    };
  }, [load]);

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

  return (
    <aside className="chat">
      <h2>Chat</h2>

      <div className="chat-log" ref={listRef} onScroll={onScroll}>
        {messages.map((m) => (
          <div
            key={m.id}
            className={`chat-msg${m.role === 'dm' ? ' from-gm' : ''}${m.secret ? ' secret' : ''}`}
          >
            <div className="chat-meta">
              <strong>{m.author}</strong>
              <span>{time(m.at)}</span>
              {/* Anyone reading this line is either the DM or the person who
                  rolled it - the server never sends it to anybody else. Saying
                  so is what stops it being read as a public result. */}
              {m.secret && <span className="badge secret-badge">DM only</span>}
            </div>
            {m.kind === 'roll' && m.roll ? <RollResult roll={m.roll} /> : <p>{m.text}</p>}
          </div>
        ))}
        {messages.length === 0 && <p className="empty">No messages yet.</p>}
      </div>

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
  const { count, sides, modifier, rolls, total, advantage, label } = roll;
  // Named things that rolled with this one and are already in its total. Absent
  // on every roll made before they existed, and on most made since.
  const extras = roll.extras || [];
  const sign = modifier > 0 ? `+${modifier}` : `${modifier}`;
  // With advantage only the best die counts; the other is shown struck through
  // so you can see what it beat.
  const best = advantage ? Math.max(...rolls) : null;
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
        {advantage ? ' · advantage' : ''}
      </span>
      <span className="roll-dice">
        {rolls.map((r, i) => {
          // Exactly one die is kept, even when both rolled the same number.
          const dropped = advantage && !(r === best && !keptSeen);
          if (advantage && r === best && !keptSeen) keptSeen = true;
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
