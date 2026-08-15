import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import ImageCloud from './ImageCloud.jsx';

/**
 * Everything about the scenes, in one window instead of along the top of the
 * map.
 *
 * The scene bar had grown into eight controls, six of which only the DM could
 * use and none of which are needed while anybody is actually playing: the name
 * of the scene, a picker of built-in maps, an upload, a paste, a new-scene
 * button and a delete. They were sitting across the top of the board being
 * read past. They live here now, behind one button, and the board keeps the
 * three things you use mid-session: which scene, how far in, and the grid.
 *
 * Deliberately **not** a FloatingWindow. The character sheets are floating
 * because you play with them open - you drag them aside, fade them down, keep
 * two of them up at once. This is a workbench you come to, do something at, and
 * leave, so it is a fixed dialog: no drag, no resize, no opacity, no
 * minimising. Sized against the map rather than the window, so it does not sit
 * under the chat.
 */
export default function SceneManager({
  scenes,
  activeId,
  scene,
  maps,
  busy,
  onSelect,
  onRename,
  onCreate,
  onDelete,
  onUse,
  onClose,
}) {
  // The name as it is being typed. Committed on blur, exactly as the bar did:
  // a scene's name is broadcast to the table, and saving each keystroke would
  // be a scene called "D", "Do", "Doc" on everybody's screen.
  const [name, setName] = useState(scene?.name ?? '');
  useEffect(() => {
    setName(scene?.name ?? '');
  }, [scene?.id, scene?.name]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="modal-backdrop scene-manager-back"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal scene-manager" role="dialog" aria-modal="true" aria-label="Scene manager">
        <div className="modal-head">
          <h2>Scene manager</h2>
          <button type="button" className="linky" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="sm-body">
          {/* Which scene everything to the right is about. Picking one here
              picks it on the board as well - there is one "the scene you are
              looking at", and a manager with its own private idea of which one
              that is would be a second answer to the same question. */}
          <aside className="sm-scenes">
            <h4>Scenes</h4>
            <ul>
              {scenes.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className={s.id === activeId ? 'active' : ''}
                    onClick={() => onSelect(s.id)}
                  >
                    <span className="sm-scene-name">{s.name || 'Untitled scene'}</span>
                    <small>{(s.tokens || []).length || ''}</small>
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" onClick={onCreate} disabled={busy}>
              + Scene
            </button>
          </aside>

          <section className="sm-main">
            <div className="sm-scene-head">
              <label className="fld">
                <input
                  value={name}
                  maxLength={120}
                  disabled={!scene || busy}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={(e) => onRename(e.target.value)}
                />
                <span>Scene name</span>
              </label>
              <button
                type="button"
                className="del"
                disabled={!scene || busy}
                onClick={() => onDelete(scene)}
              >
                Delete scene
              </button>
            </div>

            <p className="hint sm-hint">
              Pick a picture below and it becomes this scene's board for everyone at the table.
              Your images are yours across every table you run; the folders belong to this
              campaign.
            </p>

            <ImageCloud
              onUse={onUse}
              currentUrl={scene?.imageUrl || ''}
              builtIn={maps}
              disabled={busy}
            />
          </section>
        </div>
      </div>
    </div>,
    document.body
  );
}
