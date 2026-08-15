import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { socket } from './socket.js';
import ClipboardImage from './ClipboardImage.jsx';
import ConfirmDeleteModal from './ConfirmDeleteModal.jsx';

/**
 * The campaign's own folders full of maps.
 *
 * Written by hand rather than taken off the shelf. The file-manager packages
 * that do this well are 400kB and up, arrive with their own icon set, their own
 * font and their own idea of what a dialog looks like, and none of them supply
 * the half that is actually work here: a tree per campaign, a quota per person,
 * and a rule about what may be deleted. This is a folder list and a grid of
 * thumbnails, in the same dark idiom as the rest of the app, over an API that
 * was going to have to exist either way.
 *
 * The tree arrives whole and is kept in one array of `{ id, kind, name,
 * parentId }`; which folder is open is state here rather than a route, because
 * it is where somebody is looking rather than something about the campaign.
 *
 * Two things it deliberately does not do. There is no built-in maps *folder* in
 * the tree - those files are shipped with the app, so they are shown as their
 * own shelf above your own things rather than pretending to be in it. And
 * nothing here is sorted by anything but name: a folder full of maps is looked
 * through by eye, and a list that reordered itself when you uploaded would move
 * the thing you were about to click.
 */

const megabytes = (bytes) => (bytes || 0) / 1024 / 1024;

// What the bar under the toolbar says. One decimal below ten megabytes, none
// above: "0.4 MB" is worth knowing and "173.2 MB" is not.
const sizeText = (bytes) => {
  const mb = megabytes(bytes);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
};

// The name a file arrives with, without its extension: "docks.png" is a picture
// called docks, and the three letters after it are how the disk feels about it.
const nameFromFile = (file) => String(file?.name || 'Image').replace(/\.[^.]+$/, '');

export default function ImageCloud({ onUse, currentUrl, builtIn = [], disabled = false }) {
  const [nodes, setNodes] = useState([]);
  const [quota, setQuota] = useState({ used: 0, limit: 0 });
  // Which folder is open. Null is the root.
  const [openId, setOpenId] = useState(null);
  // The node being renamed, and the text so far.
  const [editing, setEditing] = useState(null);
  const [doomed, setDoomed] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // What is being dragged, so a folder can light up as a target.
  const [dragId, setDragId] = useState('');
  const [overId, setOverId] = useState('');
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const { nodes: rows, quota: q } = await api.listCloud();
      setNodes(rows);
      setQuota(q);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Another DM at the same table tidying their folders is a change to this
  // list. The nudge carries nothing; asking again is cheap and always right.
  useEffect(() => {
    socket.on('cloud:changed', load);
    return () => socket.off('cloud:changed', load);
  }, [load]);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // Where we are, root first, for the breadcrumb and for the drag targets it
  // doubles as: dropping a card on a crumb moves it up to that folder.
  const trail = useMemo(() => {
    const out = [];
    let cursor = openId;
    while (cursor && byId.has(cursor)) {
      const node = byId.get(cursor);
      out.unshift(node);
      cursor = node.parentId;
    }
    return out;
  }, [openId, byId]);

  // A folder that has been deleted by somebody else while we stood in it drops
  // us back to the root rather than showing an empty room with no way out.
  useEffect(() => {
    if (openId && !byId.has(openId)) setOpenId(null);
  }, [openId, byId]);

  const here = useMemo(() => {
    const mine = nodes.filter((n) => (n.parentId || null) === openId);
    const byName = (a, b) => String(a.name).localeCompare(String(b.name));
    return [
      ...mine.filter((n) => n.kind === 'folder').sort(byName),
      ...mine.filter((n) => n.kind === 'image').sort(byName),
    ];
  }, [nodes, openId]);

  async function run(fn) {
    if (busy || disabled) return;
    setBusy(true);
    setError('');
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const addFolder = () => run(() => api.createCloudFolder('New folder', openId));

  const upload = (file) =>
    run(async () => {
      await api.uploadCloudImage(file, { name: nameFromFile(file), parentId: openId });
    });

  const rename = (node, name) =>
    run(async () => {
      if (name.trim() && name.trim() !== node.name) {
        await api.updateCloudNode(node.id, { name: name.trim() });
      }
    });

  const moveTo = (nodeId, parentId) =>
    run(async () => {
      if (nodeId === parentId) return;
      await api.updateCloudNode(nodeId, { parentId });
    });

  const full = quota.limit > 0 && quota.used >= quota.limit;
  const percent = quota.limit > 0 ? Math.min(100, (quota.used / quota.limit) * 100) : 0;

  /* Drag and drop, with the same handful of handlers on every card: a folder
     is a target, an image is not, and the crumbs at the top are targets too so
     that "put this back a level" needs no menu. */
  const dragProps = (node) => ({
    draggable: !disabled,
    onDragStart: (e) => {
      setDragId(node.id);
      e.dataTransfer.effectAllowed = 'move';
      // Set for the browser's sake; nothing reads it back. Firefox refuses to
      // start a drag at all without some data on the transfer.
      e.dataTransfer.setData('text/plain', node.id);
    },
    onDragEnd: () => {
      setDragId('');
      setOverId('');
    },
  });

  const dropProps = (targetId) => ({
    onDragOver: (e) => {
      if (!dragId || dragId === targetId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setOverId(targetId || 'root');
    },
    onDragLeave: () => setOverId(''),
    onDrop: (e) => {
      e.preventDefault();
      setOverId('');
      if (dragId && dragId !== targetId) moveTo(dragId, targetId);
      setDragId('');
    },
  });

  return (
    <div className="cloud">
      <div className="cloud-bar">
        <nav className="cloud-crumbs" aria-label="Folders">
          <button
            type="button"
            className={`crumb${overId === 'root' ? ' over' : ''}`}
            onClick={() => setOpenId(null)}
            {...dropProps(null)}
          >
            My images
          </button>
          {trail.map((node) => (
            <span key={node.id}>
              <i>/</i>
              <button
                type="button"
                className={`crumb${overId === node.id ? ' over' : ''}`}
                onClick={() => setOpenId(node.id)}
                {...dropProps(node.id)}
              >
                {node.name}
              </button>
            </span>
          ))}
        </nav>

        <div className="cloud-actions">
          <button type="button" onClick={addFolder} disabled={busy || disabled}>
            + Folder
          </button>
          <label className="upload">
            Upload image
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              disabled={busy || disabled || full}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = ''; // let the same file be picked again
                if (file) upload(file);
              }}
            />
          </label>
          {/* The same act as the button beside it: a map cropped out of a PDF
              is on the clipboard already, and saving it to disk first is a step
              that exists only to satisfy a file picker. */}
          <ClipboardImage onImage={upload} disabled={busy || disabled || full} />
        </div>
      </div>

      {/* What is left, said as a bar and a line. Only the picture's own bytes
          are counted, and they are counted against whoever uploaded them
          wherever they uploaded them - so this number follows you from table to
          table. */}
      <div className="cloud-quota" title="Shared across every table you run">
        <span className="cloud-quota-track">
          <span className={`cloud-quota-fill${percent > 90 ? ' full' : ''}`} style={{ width: `${percent}%` }} />
        </span>
        <small>
          {sizeText(quota.used)} of {sizeText(quota.limit)} used
        </small>
      </div>

      {error && <p className="error">{error}</p>}

      <div className={`cloud-grid${overId === 'root' && !openId ? ' over' : ''}`}>
        {here.length === 0 && (
          <p className="hint cloud-empty">
            Nothing here yet. Upload an image, or paste one you have copied, and it lands in this
            folder.
          </p>
        )}

        {here.map((node) =>
          node.kind === 'folder' ? (
            <div
              key={node.id}
              className={`cloud-card folder${overId === node.id ? ' over' : ''}${dragId === node.id ? ' dragging' : ''
                }`}
              {...dragProps(node)}
              {...dropProps(node.id)}
              onDoubleClick={() => setOpenId(node.id)}
            >
              <button type="button" className="cloud-face" onClick={() => setOpenId(node.id)}>
                <span className="cloud-folder-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
                  </svg>
                </span>
              </button>
              <CardName
                node={node}
                editing={editing}
                setEditing={setEditing}
                onRename={rename}
                disabled={disabled}
              />
              {!disabled && (
                <div className="cloud-card-tools">
                  <button type="button" onClick={() => setEditing({ id: node.id, name: node.name })}>
                    Rename
                  </button>
                  <button type="button" className="del" onClick={() => setDoomed(node)}>
                    ✕
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div
              key={node.id}
              className={`cloud-card image${node.url === currentUrl ? ' current' : ''}${dragId === node.id ? ' dragging' : ''
                }`}
              {...dragProps(node)}
            >
              <button
                type="button"
                className="cloud-face"
                title={`Use ${node.name} as this scene's background`}
                disabled={disabled || !onUse}
                onClick={() => onUse?.(node.url)}
                style={{ backgroundImage: `url(${JSON.stringify(node.url)})` }}
              >
                {node.url === currentUrl && <span className="cloud-current">In use</span>}
              </button>
              <CardName
                node={node}
                editing={editing}
                setEditing={setEditing}
                onRename={rename}
                disabled={disabled}
              />
              <div className="cloud-card-tools">
                <button type="button" disabled={disabled || !onUse} onClick={() => onUse?.(node.url)}>
                  Use
                </button>
                {!disabled && (
                  <>
                    <button
                      type="button"
                      onClick={() => setEditing({ id: node.id, name: node.name })}
                    >
                      Rename
                    </button>
                    <button type="button" className="del" onClick={() => setDoomed(node)}>
                      ✕
                    </button>
                  </>
                )}
              </div>
              <small className="cloud-size">{sizeText(node.bytes)}</small>
            </div>
          )
        )}
      </div>

      {/* The maps that came with the app. Their own shelf under your folders
          rather than a folder among them: they are the same for everybody, they
          cannot be renamed or thrown away, and pretending otherwise would be a
          folder whose every action is refused. Only at the root, because they
          are not inside anything of yours. */}
      {!openId && builtIn.length > 0 && (
        <div className="cloud-builtin">
          <h4>Maps that came with the app</h4>
          <div className="cloud-grid">
            {builtIn.map((map) => (
              <div key={map.url} className={`cloud-card image${map.url === currentUrl ? ' current' : ''}`}>
                <button
                  type="button"
                  className="cloud-face"
                  title={`Use ${map.name} as this scene's background`}
                  disabled={disabled || !onUse}
                  onClick={() => onUse?.(map.url)}
                  style={{ backgroundImage: `url(${JSON.stringify(map.url)})` }}
                >
                  {map.url === currentUrl && <span className="cloud-current">In use</span>}
                </button>
                <span className="cloud-name">{map.name}</span>
                <div className="cloud-card-tools">
                  <button type="button" disabled={disabled || !onUse} onClick={() => onUse?.(map.url)}>
                    Use
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {doomed && (
        <ConfirmDeleteModal
          name={doomed.name}
          description={
            doomed.kind === 'folder'
              ? 'This deletes the folder and everything inside it, pictures included. A picture that is the background of a scene is not deleted at all: change those scenes first.'
              : 'This deletes the picture for good and gives you the space back. If it is the background of a scene, it is not deleted: change that scene first.'
          }
          confirmLabel={doomed.kind === 'folder' ? 'Delete folder' : 'Delete image'}
          onConfirm={async () => {
            // Thrown rather than caught: the dialog is the thing in front of
            // whoever asked, so it stays open and says why. Catching it here as
            // well would print the same refusal twice, once behind the other.
            await api.deleteCloudNode(doomed.id);
            await load();
          }}
          onClose={() => setDoomed(null)}
        />
      )}
    </div>
  );
}

/**
 * A card's name, which becomes a text box while it is being renamed.
 *
 * In place rather than in a dialog: renaming a folder is a small thing done
 * often, and a modal in front of a modal to change one word would be two
 * things to dismiss. Enter and blur both commit, Escape gives up.
 */
function CardName({ node, editing, setEditing, onRename, disabled }) {
  const live = editing?.id === node.id;
  if (!live) {
    return (
      <button
        type="button"
        className="cloud-name"
        title={disabled ? node.name : `${node.name} - click to rename`}
        disabled={disabled}
        onClick={() => setEditing({ id: node.id, name: node.name })}
      >
        {node.name}
      </button>
    );
  }
  // Committed here rather than by asking the box to blur itself. Enter used to
  // call blur() and let the blur handler do the work, which is one line shorter
  // and quietly does nothing at all when the box does not happen to hold the
  // focus - the edit then sits there looking unsaved with no way to finish it.
  const commit = () => {
    onRename(node, editing.name);
    setEditing(null);
  };

  return (
    <input
      className="cloud-name-edit"
      autoFocus
      value={editing.name}
      maxLength={80}
      onChange={(e) => setEditing({ id: node.id, name: e.target.value })}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setEditing(null);
      }}
    />
  );
}
