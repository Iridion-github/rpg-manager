import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePortalTarget } from './portalTarget.js';
import { formatDateTime } from './dateFormat.js';
import { describeSheet, readSheetFile } from './sheetFile.js';

/**
 * Pouring a character out of a file and into this sheet.
 *
 * Two steps on purpose, and the gap between them is the point: the file is read
 * and described first, and only then is there a button to commit. What is
 * written over is a character somebody has been playing, and "pick a file" is
 * not a decision anybody should be able to make by accident with one click.
 *
 * Nothing is sent until Confirm. Picking the wrong file costs a line of red
 * text and another press of the picker.
 */

// A character sheet is a few kilobytes of JSON. Anything this size is not one,
// and reading it would only be a way to hang the browser on a video somebody
// picked by mistake.
const MAX_BYTES = 2 * 1024 * 1024;

export default function SheetImportModal({ sheet, onConfirm, onClose }) {
  // Where a dialog goes: the page, or the window it was popped out into.
  const portalTarget = usePortalTarget();
  // What was read out of the file, ready to go in. Null until a good one lands.
  const [incoming, setIncoming] = useState(null);
  const [from, setFrom] = useState('');
  const [exportedAt, setExportedAt] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  async function pick(file) {
    setIncoming(null);
    setExportedAt(null);
    setFrom(file?.name || '');
    setError('');
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError('That file is far too big to be a character sheet.');
      return;
    }
    let text = '';
    try {
      text = await file.text();
    } catch {
      setError('That file could not be read.');
      return;
    }
    const read = readSheetFile(text);
    if (read.error) {
      setError(read.error);
      return;
    }
    setIncoming(read.sheet);
    setExportedAt(read.exportedAt);
  }

  async function confirm() {
    if (!incoming || busy) return;
    setBusy(true);
    setError('');
    try {
      await onConfirm(incoming);
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal sheet-import" role="dialog" aria-modal="true" aria-label="Import character">
        <div className="modal-head">
          <h2>Import character</h2>
          <button type="button" className="linky" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <p className="hint">
          Choose a file written by <strong>Export</strong>. It is read here and nothing is written
          until you say so.
        </p>

        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          disabled={busy}
          onChange={(e) => pick(e.target.files?.[0])}
        />

        {/* What is actually in the file, so the decision below is made against
            the character rather than against a filename. */}
        {incoming && (
          <div className="import-found">
            <strong>{incoming.name || 'Unnamed character'}</strong>
            <small>{describeSheet(incoming) || 'No class or level set'}</small>
            <small className="import-source">
              from {from}
              {exportedAt ? ` · exported ${formatDateTime(exportedAt)}` : ''}
            </small>
          </div>
        )}

        {error && <p className="error">{error}</p>}

        {/* The warning sits beside the button rather than above the file picker:
            it is about pressing *this*, and a caution read a minute ago while
            choosing a file is a caution nobody is reading now. */}
        <div className="import-commit">
          <p className="warn-box">
            <strong>This overwrites {sheet?.name || 'this character'}.</strong> Everything on the
            sheet - abilities, kit, spells, notes - is replaced by what is in the file, for
            everybody it is shared with. It cannot be undone, so export the current version first
            if you might want it back.
          </p>
          <div className="modal-actions">
            <button type="button" className="linky" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="del" disabled={!incoming || busy} onClick={confirm}>
              {busy ? 'Importing…' : 'Confirm Import'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    portalTarget
  );
}
