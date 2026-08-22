import { Fragment, useCallback, useEffect, useState } from 'react';
import { branchesOf, describe, contentsOf, fetchNode, isLeaf, proseOf } from './srd.js';

const ROOT = '/api/2014/equipment-categories';

/**
 * The equipment shelf: the SRD's gear, read a level at a time.
 *
 * A reference book rather than anything belonging to this table - nothing here
 * is saved, nothing is anybody's, and every player sees the same thing. It is a
 * tab so that the question "what does a shield cost" can be answered without
 * leaving the app for a browser tab that then stays open all evening.
 *
 * ## How it walks
 *
 * Categories across the top, one of them chosen, and whatever that leads to
 * below. The rules for where a click goes are in srd.js, which is also where
 * the reason for each of them is written; this file is the drawing.
 *
 * One thing is worth repeating here because it is visible: a category holding a
 * single item is stepped straight through. Clicking Shields shows the shield,
 * not a list of one button reading "Shield". The spinner stays up across both
 * requests, so it reads as one wait rather than two.
 *
 * ## Loading
 *
 * Every fetch shows the spinner and every fetch takes at least half a second,
 * whether or not anybody had to be asked - see MIN_LOAD_MS. The server caches
 * what it has fetched, so without that floor the second visit to a category
 * would flash rather than load, and a flash reads as a fault.
 */
export default function Items() {
  const [categories, setCategories] = useState([]);
  // Which category's button is lit, by index ('armor'). Empty before a choice.
  const [chosen, setChosen] = useState('');
  // The thing on show, once the walk has reached one: the raw document.
  const [entry, setEntry] = useState(null);
  // The list to pick from, when a category has more than one thing in it.
  const [choices, setChoices] = useState([]);
  /**
   * Where you are, as the steps that got you there: `{ path, label }` each.
   *
   * The path and the name, and nothing else. Going back asks for the document
   * again rather than holding on to the one it gave last time - it costs a
   * request the server has almost certainly cached, and it means a crumb can
   * never put a stale page back on screen. Keeping the answers would be saving
   * a copy of somebody else's book to avoid a walk to the shelf it is on.
   */
  const [trail, setTrail] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadCategories = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const root = await fetchNode(ROOT);
      setCategories(root.results || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  /**
   * Follow one path, and keep following while there is only one way on.
   *
   * The loop is what makes a category of one behave like a shortcut rather than
   * like a dead end with a single door in it. It is a loop rather than a special
   * case for Shields because the shape of the data is what decides it, and the
   * shape of the data is not this app's to promise.
   *
   * A ceiling on the walk, because a loop that trusts somebody else's data to
   * terminate is a loop that hangs the tab the day their data changes. Three is
   * already one more level than the tree has.
   */
  const follow = useCallback(async (startPath) => {
    setLoading(true);
    setError('');
    setEntry(null);
    setChoices([]);
    try {
      let path = startPath;
      for (let step = 0; step < 4; step += 1) {
        const node = await fetchNode(path);
        if (isLeaf(node, path)) {
          setEntry(node);
          return;
        }
        const next = branchesOf(node);
        if (next.length === 1) {
          path = next[0].url;
          continue;
        }
        setChoices(next);
        return;
      }
      setError('That goes round in circles - the reference site is not answering as expected.');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  /** A category from the row above: the trail starts again at that category. */
  const openCategory = (category) => {
    setChosen(category.index);
    setTrail([{ path: category.url, label: category.name }]);
    follow(category.url);
  };

  /** A step further in, from the list: the trail grows by one. */
  const openChoice = (choice) => {
    setTrail((t) => [...t, { path: choice.url, label: choice.name }]);
    follow(choice.url);
  };

  /** A step back out: the trail is cut to that crumb and its call made again. */
  const goBackTo = (index) => {
    const crumb = trail[index];
    if (!crumb) return;
    setTrail((t) => t.slice(0, index + 1));
    follow(crumb.path);
  };

  return (
    <div className="items-view">
      <h2 className="items-title">Items</h2>
      <p className="hint">
        The equipment from the 5e SRD, for looking things up mid-game. Nothing here belongs to
        this table and nothing is saved.
      </p>

      {/* The categories. Always on screen once they have loaded, so that moving
          from one to the next is one click rather than a click and a Back. */}
      {categories.length > 0 && (
        <div className="items-cats" role="tablist" aria-label="Equipment categories">
          {categories.map((c) => (
            <button
              key={c.index}
              type="button"
              role="tab"
              aria-selected={chosen === c.index}
              className={chosen === c.index ? 'active' : ''}
              disabled={loading}
              onClick={() => openCategory(c)}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}

      {/* Where you are, and the way back out of it. The categories above never
          leave the screen, so this only has to cover the steps taken inside one
          of them: at most a couple, and often none at all. The last crumb is
          where you are standing rather than somewhere to go, so it is not a
          button - a button that does nothing is worse than no button. */}
      {trail.length > 0 && (
        <nav className="items-crumbs" aria-label="Breadcrumb">
          {trail.map((crumb, i) => (
            <Fragment key={`${crumb.path}-${i}`}>
              {i > 0 && <span aria-hidden="true">/</span>}
              {i === trail.length - 1 ? (
                <span className="current" aria-current="page">
                  {crumb.label}
                </span>
              ) : (
                <button type="button" disabled={loading} onClick={() => goBackTo(i)}>
                  {crumb.label}
                </button>
              )}
            </Fragment>
          ))}
        </nav>
      )}

      {error && <p className="error">{error}</p>}

      {loading && <Spinner />}

      {/* What the category led to. One of three things: a list to choose from,
          one entry, or - before anything has been chosen - nothing at all. */}
      {!loading && !error && choices.length > 0 && (
        <div className="items-list">
          {choices.map((c) => (
            <button key={c.index} type="button" onClick={() => openChoice(c)}>
              {c.name}
            </button>
          ))}
        </div>
      )}

      {!loading && !error && entry && <Entry node={entry} />}

      {!loading && !error && !entry && !choices.length && categories.length > 0 && (
        <p className="empty">Pick a category to see what is in it.</p>
      )}
    </div>
  );
}

/**
 * Something is happening.
 *
 * Drawn rather than written, for the reason the window's own marks are: a
 * spinning character borrowed from whatever font the system supplies lands at a
 * different size and baseline on every machine.
 */
function Spinner() {
  return (
    <div className="items-loading" role="status" aria-live="polite">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="9" />
      </svg>
      <span>Loading…</span>
    </div>
  );
}

/**
 * One piece of equipment, laid out.
 *
 * The facts as a two-column list, the prose under it, and what is in it if it
 * is a pack. Everything is built by `describe`, which leaves out whatever this
 * particular entry has nothing to say about - so an entry is as long as it has
 * reason to be rather than a grid of blanks.
 */
function Entry({ node }) {
  const rows = describe(node);
  const contents = contentsOf(node);
  const prose = proseOf(node).filter((p) => p.lines.length);

  return (
    <article className="items-entry">
      <h3>{node.name}</h3>

      {rows.length > 0 && (
        <dl className="items-facts">
          {rows.map((r) => (
            <div key={r.label}>
              <dt>{r.label}</dt>
              <dd>{r.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {contents.length > 0 && (
        <section className="items-contents">
          <h4>Contains</h4>
          <ul>
            {contents.map((c) => (
              <li key={c.name}>
                {c.quantity} × {c.name}
              </li>
            ))}
          </ul>
        </section>
      )}

      {prose.map((p) => (
        <section key={p.heading} className="items-prose">
          <h4>{p.heading}</h4>
          {p.lines.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </section>
      ))}
    </article>
  );
}
