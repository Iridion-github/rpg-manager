/**
 * Who else may read this: nobody, some people, or the whole table.
 *
 * Three states rather than a switch, because "shared" turned out to be two
 * different decisions wearing one word - handing the party a letter they all
 * just read, and telling one player what their character alone noticed. A
 * switch can only do the first.
 *
 * Public is deliberately not "everyone, as a list of names": it asks the
 * campaign who its members are at the moment somebody reads it, so a player who
 * joins next month gets what the table already has rather than a silence nobody
 * remembers to fix.
 *
 * Folded away by default, like the character sheets' access panel and for the
 * same reason: it is consulted when something changes hands, against a thing
 * that is read every session. The summary is on the fold, so it never has to be
 * opened to be answered.
 *
 * Written once and used by both the things that can be handed out - a handout
 * in the Notes tab and a pin stuck in a map - because they are the same
 * decision about two different objects, and two copies of it would eventually
 * offer the table two slightly different promises.
 */

/** The answer in words, for the panel's own summary line. */
export function shareSummary({ visibility, sharedWith }, players) {
  if (visibility === 'public') return 'Everyone at this table';
  if (visibility !== 'shared') return 'Nobody but you';
  const names = (sharedWith || [])
    .map((id) => players.find((p) => p.id === id))
    .filter(Boolean)
    .map((p) => p.name);
  if (names.length === 0) return 'Nobody yet';
  if (names.length <= 3) return names.join(' · ');
  return `${names.slice(0, 2).join(' · ')} and ${names.length - 2} others`;
}

export default function SharePanel({
  // What is being shared, as its two fields. Not the whole record: a note and a
  // pin agree about these two and about nothing else.
  visibility = 'private',
  sharedWith = [],
  players = [],
  actor,
  onShare,
  // Which radio group this is. Two of these on screen at once - a pin open over
  // the map while a note is open beside it - would otherwise share one group
  // and fight over which is ticked.
  name,
  // The sentence under the list, which says what sharing costs and what it
  // doesn't. Its wording belongs to the caller, since a handout and a pin are
  // taken back in different places.
  footer,
}) {
  // Everybody at the table except whoever is doing the sharing - the author
  // reads their own by definition, so a tick beside their own name would be a
  // control that changes nothing.
  const others = players.filter((p) => p.id !== actor?.userId);

  const choose = (next) => {
    if (next === visibility) return;
    // The list of names is kept when the answer moves off Shared, rather than
    // emptied: switching to Public to read something out and back again should
    // not cost somebody the three ticks they set before.
    onShare({ visibility: next, sharedWith });
  };

  const toggle = (id) => {
    const next = sharedWith.includes(id)
      ? sharedWith.filter((x) => x !== id)
      : [...sharedWith, id];
    onShare({ visibility: 'shared', sharedWith: next });
  };

  return (
    <details className="share-panel">
      <summary>
        Who can read this - <strong>{shareSummary({ visibility, sharedWith }, players)}</strong>
      </summary>

      <div className="share-choices">
        {[
          ['private', 'Private', 'Yours alone. Nobody else at the table sees it, DM or player.'],
          ['shared', 'Shared with…', 'Only the people you tick below.'],
          ['public', 'Public', 'Everyone here, and anyone who joins later.'],
        ].map(([value, label, hint]) => (
          <label key={value} className={`share-choice${visibility === value ? ' on' : ''}`}>
            <input
              type="radio"
              name={name}
              checked={visibility === value}
              onChange={() => choose(value)}
            />
            <span>
              <strong>{label}</strong>
              <small>{hint}</small>
            </span>
          </label>
        ))}
      </div>

      {/* Only under the answer it belongs to. A list of names beside something
          marked Public would invite the reading that those are the only people
          who can see it. */}
      {visibility === 'shared' &&
        (others.length === 0 ? (
          <p className="hint">
            Nobody else is at this table yet. Add players under Campaigns → Members and they will
            appear here.
          </p>
        ) : (
          <ul className="share-list">
            {others.map((p) => (
              <li key={p.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={sharedWith.includes(p.id)}
                    onChange={() => toggle(p.id)}
                  />
                  <span>{p.name}</span>
                </label>
                {/* A co-DM is a person at this table like any other, and gets
                    no more of your prep than you give them. Saying which they
                    are is worth one word. */}
                {p.role === 'dm' && <span className="badge role gm">DM</span>}
              </li>
            ))}
          </ul>
        ))}

      {footer && <p className="hint">{footer}</p>}
    </details>
  );
}
