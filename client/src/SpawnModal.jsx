import { createPortal } from 'react-dom';

/**
 * The tokens that aren't on any map, offered back to the spot you right-clicked.
 *
 * The list arrives already filtered by the server: the DM is offered the whole
 * bench, everyone else is offered the tokens that belong to them, which is
 * exactly the set they'd be allowed to place. Nothing here is drawn that would
 * come back refused.
 *
 * Each one is shown as it will look on the board — the same face, the same
 * colour — because that is how it will be recognised once it's there, and a
 * list of names is a worse answer than a list of faces at a table with three
 * goblins on it.
 */
export default function SpawnModal({ bench, owners, onPick, onClose }) {
  const nameOf = (ownerId) => owners.find((p) => p.id === ownerId)?.name || null;

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal spawn-modal" role="dialog" aria-modal="true" aria-label="Place a token">
        <div className="modal-head">
          <h2>Place a token</h2>
          <button type="button" className="linky" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {bench.length === 0 ? (
          <p className="hint">
            Nothing is waiting off the table. A token gets here by being taken off one —
            right-click it and choose <strong>Remove from table</strong>, which keeps it for
            later rather than deleting it.
          </p>
        ) : (
          <>
            <p className="hint">It goes where you right-clicked.</p>
            <ul className="spawn-list">
              {bench.map((t) => (
                <li key={t.id}>
                  <button type="button" onClick={() => onPick(t)}>
                    <span
                      className="spawn-face"
                      style={{
                        background: t.imageUrl
                          ? `center / cover no-repeat url(${JSON.stringify(t.imageUrl)})`
                          : t.color,
                        ...(t.borderColor ? { borderColor: t.borderColor } : {}),
                      }}
                    />
                    <span className="spawn-who">
                      <strong>{t.label}</strong>
                      {nameOf(t.ownerId) && <small>{nameOf(t.ownerId)}'s</small>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
