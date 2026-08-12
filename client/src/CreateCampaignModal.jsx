import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * "What table are we starting?" - a name, a subtitle, and optionally a whole
 * campaign in a file.
 *
 * The file is read and checked here rather than on submit, so that "is this
 * usable?" is answered while you're still looking at the file picker instead of
 * after you've committed to making something. What the server does with it is
 * checked again on the way in; this is the fast answer, not the authority.
 *
 * Three states, and they behave differently on purpose:
 *   nothing   - no file chosen, both buttons offered
 *   accepted  - green, and an Undo that puts you back to nothing
 *   rejected  - red, and it *stays* red until the next attempt, because an
 *               error that clears itself is one you can miss entirely
 */

// What the server writes into every export. A file without it isn't ours.
const FORMAT = 'rpg-manager-campaign';
const VERSION = 1;

/**
 * The same envelope check the server makes, for the same reasons - the marker
 * first, so a JSON file that merely parses is refused rather than half-read.
 * Not a schema check: the server sanitizes every record it writes, and a second
 * copy of those rules here would be the copy that drifts.
 */
function checkExport(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (data.format !== FORMAT) return false;
  if (!Number.isInteger(data.version) || data.version > VERSION) return false;
  if (!data.campaign || typeof data.campaign !== 'object') return false;
  if (!data.collections || typeof data.collections !== 'object') return false;
  return Object.values(data.collections).every((records) => Array.isArray(records));
}

export default function CreateCampaignModal({ onCreate, onClose }) {
  const [name, setName] = useState('');
  const [subtitle, setSubtitle] = useState('');
  // null | { ok: true, data } | { ok: false }
  const [upload, setUpload] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function readFile(file) {
    if (!file) return;
    setError('');
    try {
      const data = JSON.parse(await file.text());
      if (!checkExport(data)) throw new Error('not an export');
      setUpload({ ok: true, data });
      // Only into what's empty. Something you typed is an answer; the file is
      // a suggestion, and a suggestion doesn't overrule an answer.
      if (!name.trim()) setName(data.campaign.name || '');
      if (!subtitle.trim()) setSubtitle(data.campaign.subtitle || '');
    } catch {
      setUpload({ ok: false });
    } finally {
      // Cleared so choosing the same file twice in a row still fires a change.
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function undoUpload() {
    setUpload(null);
    setError('');
    // The fields are left as they are. They may have been filled from the file,
    // but by now they may also have been edited, and there is no way to tell
    // the two apart - clearing them would throw away work to undo a click.
  }

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onCreate({
        name: name.trim(),
        subtitle: subtitle.trim(),
        imported: upload?.ok ? upload.data : null,
      });
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
      <form className="modal" role="dialog" aria-modal="true" aria-label="Create campaign" onSubmit={submit}>
        <div className="modal-head">
          <h2>Create campaign</h2>
          <button type="button" className="linky" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <label className="token-field">
          Name
          <input
            autoFocus
            value={name}
            maxLength={120}
            placeholder="New Campaign"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className="token-field">
          Subtitle
          <input
            value={subtitle}
            maxLength={200}
            placeholder="Optional"
            onChange={(e) => setSubtitle(e.target.value)}
          />
        </label>

        <div className="import-row">
          {/* A label wrapping a hidden file input: the same button treatment the
              map upload uses, because it is the same gesture. */}
          <label className="upload">
            {upload?.ok ? 'Choose a different file' : 'Import campaign'}
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              onChange={(e) => readFile(e.target.files?.[0])}
            />
          </label>
          {upload?.ok && (
            <button type="button" className="linky" onClick={undoUpload}>
              Undo upload
            </button>
          )}
        </div>

        {upload?.ok && (
          <p className="banner good">The campaign will be created based on the uploaded file.</p>
        )}
        {upload && !upload.ok && <p className="banner bad">Invalid file provided.</p>}

        {error && <p className="error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="linky" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create campaign'}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}
