import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { UNITS, unitNamed } from './measure.js';
import { toCells, toUnit } from './fog.js';

/**
 * Fog of war: who sees how far, and whether the lights are out.
 *
 * The DM's window and nobody else's. Two numbers per creature - where sharp
 * sight ends, and where sight ends altogether - written in whatever unit this
 * map is measured in, and one button that puts the table in the dark.
 *
 * Everything here saves as it is typed. There is no Save: a window whose numbers
 * were only written down when it was closed would be a window somebody set up
 * and then lost by pressing Escape, and the numbers are individually small
 * enough that a write each is nothing. Closing it changes nothing at all, which
 * is why it can be closed while the fog is armed and reopened later to find
 * itself exactly as it was.
 *
 * What is stored is *cells*, on each token (see fog.js). The unit and the scale
 * are the scene's, so changing the scale re-reads every number in here without
 * touching a single creature: eight cells is forty feet at five to the square
 * and eighty at ten, and both are the same darkvision.
 */

// How long a number sits still before it is written. The same bargain the
// grid's sliders make: one write per adjustment, not one per keystroke.
const SAVE_MS = 500;

export default function FogSettings({
  fog,
  tokens = [],
  players = [],
  onFog,
  onVision,
  onClose,
  offline,
}) {
  const perCell = Number(fog.perCell) || unitNamed(fog.unit).perCell;
  const suffix = unitNamed(fog.unit).suffix;
  /**
   * What is in the boxes right now, keyed `tokenId:field`.
   *
   * Held apart from the tokens so that a half-typed number is not a saved one,
   * and so that the round trip - typed, converted to cells, sent, echoed back,
   * converted to the unit again - cannot rewrite the field under the cursor.
   * A field with no draft shows what is stored.
   */
  const [drafts, setDrafts] = useState({});
  const [asking, setAsking] = useState(false);
  const timers = useRef(new Map());

  // Anything still waiting when the window closes is a change somebody made and
  // would expect to find later.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  function edit(token, field, value) {
    const key = `${token.id}:${field}`;
    setDrafts((d) => ({ ...d, [key]: value }));
    clearTimeout(timers.current.get(key));
    timers.current.set(
      key,
      setTimeout(() => {
        timers.current.delete(key);
        onVision(token.id, { [field]: toCells(value, perCell) });
        // Let the stored value speak again once it has been written, so a
        // number the server rounded or refused doesn't linger here as a lie.
        setDrafts((d) => {
          const next = { ...d };
          delete next[key];
          return next;
        });
      }, SAVE_MS)
    );
  }

  const shown = (token, field) => {
    const key = `${token.id}:${field}`;
    return key in drafts ? drafts[key] : toUnit(token[field], perCell);
  };

  const ownerOf = (token) =>
    token.ownerId ? players.find((p) => p.id === token.ownerId)?.name || 'somebody who has left' : '';

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal fog-modal" role="dialog" aria-modal="true" aria-label="Fog of war">
        <div className="modal-head">
          <h2>Fog of war</h2>
          <button type="button" className="linky" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {/* What the numbers below are written in. Both belong to the map: a
            plan drawn at ten feet to the square is a normal thing to be handed,
            and without the scale beside it "Feet" would only be "Cells" with a
            different word after it. */}
        <div className="fog-scale">
          <label>
            <span>Measured in</span>
            <select
              value={fog.unit}
              disabled={offline}
              onChange={(e) => {
                const unit = e.target.value;
                // The scale follows the unit unless it has been set by hand to
                // something the unit doesn't imply - changing Feet to Metres
                // should not leave a map at five metres to the square.
                onFog({ unit, perCell: unitNamed(unit).perCell });
              }}
            >
              {UNITS.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>One square is</span>
            <input
              type="number"
              min="0.1"
              step="0.1"
              value={perCell}
              disabled={offline || fog.unit === 'cells'}
              onChange={(e) => onFog({ perCell: Number(e.target.value) || perCell })}
            />
            <small>{suffix}</small>
          </label>
        </div>

        <p className="hint">
          For each creature: how far it sees clearly, and how far it sees at all. Between the two
          the map is drawn grey and drained of colour; past the second there is nothing. Leave both
          empty for a creature that sees everything, which is what every row starts as.
        </p>

        {tokens.length === 0 ? (
          <p className="hint">Nothing is standing on this scene yet.</p>
        ) : (
          <table className="fog-table">
            <thead>
              <tr>
                <th>Token</th>
                <th>Clear vision</th>
                <th>Heavily obscured vision</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((token) => {
                const owner = ownerOf(token);
                return (
                  <tr key={token.id}>
                    <td>
                      <span className="fog-token">
                        <span
                          className="fog-swatch"
                          style={{
                            background: token.imageUrl
                              ? `center / cover no-repeat url(${JSON.stringify(token.imageUrl)})`
                              : token.color,
                          }}
                        />
                        <span className="fog-name">
                          <strong>{token.label || 'Token'}</strong>
                          {/* Whose creature it is, because "Guard" three times
                              over is a list nobody can act on. */}
                          {owner && <small>{owner}</small>}
                          {token.visible === false && <small>hidden from players</small>}
                        </span>
                      </span>
                    </td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={shown(token, 'visionClear')}
                        disabled={offline}
                        placeholder="∞"
                        aria-label={`Clear vision of ${token.label || 'token'} in ${suffix}`}
                        onChange={(e) => edit(token, 'visionClear', e.target.value)}
                      />
                      <small>{suffix}</small>
                    </td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={shown(token, 'visionDim')}
                        disabled={offline}
                        placeholder="∞"
                        aria-label={`Obscured vision of ${token.label || 'token'} in ${suffix}`}
                        onChange={(e) => edit(token, 'visionDim', e.target.value)}
                      />
                      <small>{suffix}</small>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <div className="modal-actions fog-actions">
          {fog.on && (
            <span className="fog-state">
              The lights are out. Players see only what their own creatures can.
            </span>
          )}
          <div className="spacer" />
          {fog.on ? (
            <button type="button" className="del" disabled={offline} onClick={() => setAsking(true)}>
              Exit Fog of War mode
            </button>
          ) : (
            <button type="button" disabled={offline} onClick={() => onFog({ on: true })}>
              Activate Fog of War
            </button>
          )}
        </div>

        {/* Turning it off shows the whole board to everybody at once, which is
            not something to do by brushing a button while reading the table. */}
        {asking && (
          <div className="fog-confirm">
            <p>
              <strong>Turn the lights back on?</strong> Every player will see the whole map again,
              and every creature standing on it, the moment you confirm.
            </p>
            <div className="modal-actions">
              <button type="button" className="linky" onClick={() => setAsking(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="del"
                onClick={() => {
                  setAsking(false);
                  onFog({ on: false });
                }}
              >
                Exit Fog of War mode
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
