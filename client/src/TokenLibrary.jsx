import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api.js';

/**
 * The built-in token artwork, as a folder tree you can walk or a name you can
 * search for.
 *
 * One component for both places it appears: the Tokens tab, where it is a thing
 * to browse, and the token modals, where it is a thing to choose from. `onPick`
 * is the whole difference — given one, tiles become buttons.
 *
 * The listing is fetched once per page and kept here, module-level, rather than
 * per mount. It is two thousand entries that change when someone copies a file
 * into a folder, and opening the picker for the fourth time should not mean
 * asking for them a fourth time.
 */

let cached = null; // the listing, once we have it
let inFlight = null; // so two mounts in the same tick make one request

function loadTokens() {
  if (cached) return Promise.resolve(cached);
  if (!inFlight) {
    inFlight = api
      .listTokens()
      .then((files) => {
        cached = files;
        inFlight = null;
        return files;
      })
      .catch((err) => {
        inFlight = null;
        throw err;
      });
  }
  return inFlight;
}

// Folder path -> the names of the folders directly inside it. Built once from
// the flat listing: every file's folder implies each of its ancestors, so one
// pass over the files describes the whole tree without the server sending it.
function buildTree(files) {
  const children = new Map(); // path -> Set of child folder names
  const add = (parent, name) => {
    if (!children.has(parent)) children.set(parent, new Set());
    children.get(parent).add(name);
  };
  for (const file of files) {
    if (!file.folder) continue;
    const parts = file.folder.split('/');
    let parent = '';
    for (const part of parts) {
      add(parent, part);
      parent = parent ? `${parent}/${part}` : part;
    }
  }
  return children;
}

export default function TokenLibrary({ onPick, selectedUrl, emptyHint }) {
  const [files, setFiles] = useState(cached || []);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!cached);
  const [path, setPath] = useState('');
  const [query, setQuery] = useState('');
  // Browsing only. With `onPick` a click means "this one"; without it there is
  // nothing else a click could usefully mean than "let me look properly".
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    let alive = true;
    loadTokens()
      .then((list) => {
        if (!alive) return;
        setFiles(list);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setError(e.message);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const tree = useMemo(() => buildTree(files), [files]);

  const term = query.trim().toLowerCase();

  /**
   * Searching is a different view, not a filter on this one.
   *
   * A match three folders away is the whole point of typing, so the current
   * folder stops mattering the moment there is a term — and because a result
   * has been torn out of its folder, it carries that folder with it.
   */
  const results = useMemo(() => {
    if (!term) return null;
    return files.filter((f) => f.name.toLowerCase().includes(term));
  }, [files, term]);

  const folders = useMemo(
    () => [...(tree.get(path) || [])].sort((a, b) => a.localeCompare(b)),
    [tree, path]
  );
  const here = useMemo(() => files.filter((f) => f.folder === path), [files, path]);

  const crumbs = path ? path.split('/') : [];

  /**
   * The wait, said out loud.
   *
   * Deliberately not a blocking overlay. This is the one screen in the app with
   * a genuinely large answer behind it — a couple of thousand pictures to list
   * — and everything else on the page keeps working while it arrives: the map,
   * the chat, the sheets. Taking the whole app away to report on one tab's
   * loading would be a bigger interruption than the loading is.
   *
   * `role="status"` so a screen reader hears it without being dragged here.
   */
  if (loading) {
    return (
      <div className="library-loading" role="status">
        <span className="spinner" aria-hidden="true" />
        <div>
          <strong>Loading the token library…</strong>
          <p className="hint">
            There are a couple of thousand pictures in here. The list is fetched once and
            remembered for the rest of your visit, so this wait happens on the first look
            and not again.
          </p>
        </div>
      </div>
    );
  }
  if (error) return <p className="error">{error}</p>;
  if (!files.length) {
    return <p className="hint">{emptyHint || 'No token artwork found in public/tokens.'}</p>;
  }

  const tile = (file) => {
    const chosen = selectedUrl && selectedUrl === file.url;
    const inner = (
      <>
        <img src={file.url} alt="" loading="lazy" decoding="async" />
        <span className="token-tile-name">{file.name}</span>
        {/* Only when searching: a result out of its folder needs to say which
            folder that was, or two similarly named tokens are indistinguishable. */}
        {results && file.folder && <span className="token-tile-path">{file.folder}</span>}
      </>
    );
    const className = `token-tile${chosen ? ' chosen' : ''}`;
    const full = file.folder ? `${file.folder}/${file.name}` : file.name;
    return (
      <button
        type="button"
        key={file.url}
        className={className}
        onClick={() => (onPick ? onPick(file) : setPreview(file))}
        title={onPick ? full : `${full} — click to look closer`}
      >
        {inner}
      </button>
    );
  };

  return (
    <div className="token-library">
      <div className="token-library-bar">
        <input
          className="token-search"
          type="search"
          value={query}
          placeholder="Search every folder by name…"
          onChange={(e) => setQuery(e.target.value)}
        />
        {results ? (
          <span className="hint">
            {results.length} match{results.length === 1 ? '' : 'es'}
          </span>
        ) : (
          <nav className="token-crumbs">
            <button type="button" className="linky" onClick={() => setPath('')}>
              All tokens
            </button>
            {crumbs.map((part, i) => (
              <span key={part + i}>
                {' / '}
                <button
                  type="button"
                  className="linky"
                  onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}
                >
                  {part}
                </button>
              </span>
            ))}
          </nav>
        )}
      </div>

      <div className="token-library-body">
        {results ? (
          results.length ? (
            <div className="token-grid">{results.map(tile)}</div>
          ) : (
            <p className="hint">Nothing matches “{query.trim()}”.</p>
          )
        ) : (
          <>
            {folders.length > 0 && (
              <ul className="token-folders">
                {folders.map((name) => {
                  const child = path ? `${path}/${name}` : name;
                  const count = files.filter(
                    (f) => f.folder === child || f.folder.startsWith(`${child}/`)
                  ).length;
                  return (
                    <li key={child}>
                      <button type="button" onClick={() => setPath(child)}>
                        <span className="token-folder-name">{name}</span>
                        <span className="token-folder-count">{count}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {here.length > 0 && <div className="token-grid">{here.map(tile)}</div>}

            {folders.length === 0 && here.length === 0 && (
              <p className="hint">This folder is empty.</p>
            )}
          </>
        )}
      </div>

      {preview && <TokenPreview file={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
/**
 * One token, shown properly.
 *
 * No zoom: the artwork is 256px square, so magnifying it only magnifies the
 * encoder. What this is for is seeing the whole picture rather than the circle
 * the map crops it into — the part outside that circle is usually where the
 * artist put the rest of the creature.
 */
function TokenPreview({ file, onClose }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="modal-backdrop token-view-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal token-view" role="dialog" aria-modal="true" aria-label={file.name}>
        <div className="modal-head">
          <h2>{file.name}</h2>
          <button type="button" className="linky" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {file.folder && <p className="token-view-path">{file.folder}</p>}

        <div className="token-view-stage">
          <img src={file.url} alt={file.name} />
        </div>
      </div>
    </div>,
    document.body
  );
}
