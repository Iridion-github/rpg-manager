import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePortalTarget } from './portalTarget.js';
import { api } from './api.js';
import { formatDateTime } from './dateFormat.js';
import { characterOnly, describeSheet, readSheetFile } from './sheetFile.js';

/**
 * Pouring a character into this sheet - out of a file, or off another sheet of
 * your own.
 *
 * Two steps on purpose, and the gap between them is the point: what is coming
 * in is read and described first, and only then is there a button to commit.
 * What is written over is a character somebody has been playing, and "pick a
 * file" is not a decision anybody should be able to make by accident with one
 * click. The same goes for picking a name out of a list.
 *
 * Nothing is sent until Confirm. Choosing the wrong one costs another choice.
 */

// A character sheet is a few kilobytes of JSON. Anything this size is not one,
// and reading it would only be a way to hang the browser on a video somebody
// picked by mistake.
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * `offerMine` is what turns the second tab on, and it is off by default.
 *
 * On inside a campaign, where it is the other end of Save to My Characters:
 * that button puts a copy of a character on your shelf, and this is what brings
 * one back down onto a table's sheet. Off under My Characters itself, where the
 * dialog stays exactly what it always was - a shelf that can copy one of its
 * own rows onto another is a foot-gun with no journey behind it.
 */
export default function SheetImportModal({ sheet, onConfirm, onClose, offerMine = false }) {
  // Where a dialog goes: the page, or the window it was popped out into.
  const portalTarget = usePortalTarget();
  // Which of the two ways in is on screen. The file is first and is the one
  // that opens, because it is the one that works with no other character to
  // hand - and because it is what this dialog has always done.
  const [tab, setTab] = useState('file');
  // What was read out of the file, ready to go in. Null until a good one lands.
  const [incoming, setIncoming] = useState(null);
  const [from, setFrom] = useState('');
  const [exportedAt, setExportedAt] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  /**
   * Your own shelf of characters, and which of them is chosen.
   *
   * The My Characters tab's list, not the tables' - which is what makes this
   * the other end of Save to My Characters: keep a character from one campaign,
   * then pour them into a sheet at another. Null until the tab has been opened
   * once, because this is a request and a dialog opened to read a file should
   * not make one on the way up. Loaded once and kept: the list is a few dozen
   * rows and nobody adds to it in the seconds before pressing Confirm.
   */
  const [mine, setMine] = useState(null);
  const [loadingMine, setLoadingMine] = useState(false);
  const [pickedId, setPickedId] = useState('');

  useEffect(() => {
    if (tab !== 'mine' || mine || loadingMine) return;
    setLoadingMine(true);
    api
      .listMySheets()
      .then(setMine)
      .catch((e) => setError(e.message))
      .finally(() => setLoadingMine(false));
  }, [tab, mine, loadingMine]);

  const picked = (mine || []).find((s) => s.id === pickedId) || null;

  // What Confirm would send, from whichever tab is in front. One value rather
  // than two paths, so the button, the preview and the write cannot disagree
  // about which character is being brought in.
  const chosen = tab === 'file' ? incoming : picked && characterOnly(picked);
  const source =
    tab === 'file'
      ? from && `from ${from}${exportedAt ? ` · exported ${formatDateTime(exportedAt)}` : ''}`
      : picked && (picked.savedFrom ? `saved from ${picked.savedFrom}` : 'made under My Characters');

  function switchTo(next) {
    setTab(next);
    // The red text belonged to the tab it was written on. What is chosen does
    // not: switching back and forth should not cost somebody the file they
    // already picked.
    setError('');
  }

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
    if (!chosen || busy) return;
    setBusy(true);
    setError('');
    try {
      await onConfirm(chosen);
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

        {/* Only where there are two ways in. With one, a row of tabs holding a
            single tab is a label pretending to be a choice. */}
        {offerMine && (
          <nav className="modal-tabs">
            <button
              type="button"
              className={tab === 'file' ? 'active' : ''}
              disabled={busy}
              onClick={() => switchTo('file')}
            >
              From json
            </button>
            <button
              type="button"
              className={tab === 'mine' ? 'active' : ''}
              disabled={busy}
              onClick={() => switchTo('mine')}
            >
              From my characters
            </button>
          </nav>
        )}

        {tab === 'file' ? (
          <>
            <p className="hint">
              Choose a file written by <strong>Export</strong>. It is read here and nothing is
              written until you say so.
            </p>

            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              disabled={busy}
              onChange={(e) => pick(e.target.files?.[0])}
            />
          </>
        ) : (
          <>
            <p className="hint">
              The characters kept under <strong>My Characters</strong>. The one you pick is copied
              onto this sheet, and your own copy is left exactly as it was.
            </p>

            {loadingMine && <p className="hint">Looking…</p>}
            {mine && mine.length === 0 && (
              <p className="hint">
                Nothing on your shelf yet. Press <strong>Save to My Characters</strong> at the top
                of any sheet to put a copy of that character there.
              </p>
            )}
            {mine && mine.length > 0 && (
              <label className="fld">
                <select
                  value={pickedId}
                  disabled={busy}
                  onChange={(e) => {
                    setPickedId(e.target.value);
                    setError('');
                  }}
                >
                  <option value="">Choose a character…</option>
                  {/* Where a copy came from, beside the name: two characters on
                      one shelf can easily share a name - the same character
                      kept at two points in their life - and the line below only
                      says which is which after one has been picked. */}
                  {mine.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name || 'Unnamed character'}
                      {s.savedFrom ? ` · ${s.savedFrom}` : ''}
                    </option>
                  ))}
                </select>
                <span>Character</span>
              </label>
            )}
          </>
        )}

        {/* What is actually coming in, so the decision below is made against the
            character rather than against a filename or a line in a list. */}
        {chosen && (
          <div className="import-found">
            <strong>{chosen.name || 'Unnamed character'}</strong>
            <small>{describeSheet(chosen) || 'No class or level set'}</small>
            {source && <small className="import-source">{source}</small>}
          </div>
        )}

        {error && <p className="error">{error}</p>}

        {/* The warning sits beside the button rather than above the file picker:
            it is about pressing *this*, and a caution read a minute ago while
            choosing a file is a caution nobody is reading now. */}
        <div className="import-commit">
          <p className="warn-box">
            <strong>This overwrites {sheet?.name || 'this character'}.</strong> Everything on the
            sheet - abilities, kit, spells, notes - is replaced by{' '}
            {tab === 'file' ? 'what is in the file' : 'the character you pick'}, for everybody it
            is shared with. It cannot be undone, so export the current version first if you might
            want it back.
          </p>
          <div className="modal-actions">
            <button type="button" className="linky" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="del" disabled={!chosen || busy} onClick={confirm}>
              {busy ? 'Importing…' : 'Confirm Import'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    portalTarget
  );
}
