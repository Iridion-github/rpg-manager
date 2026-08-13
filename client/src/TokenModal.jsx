import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import ClipboardImage from './ClipboardImage.jsx';
import TokenLibrary from './TokenLibrary.jsx';

/**
 * "What token?" - the step between choosing Create token on the map and a
 * token appearing there, and the same form again for editing one.
 *
 * The position isn't asked for and isn't shown as a field: it's already been
 * decided by where the right-click happened, or by where the token already
 * stands. Offering coordinates to type would be a worse way to say the same
 * thing. Everything here is what the map can't tell us - what it's called, what
 * it looks like, how much room it takes.
 *
 * Pass `token` to edit it; leave it out to create a new one.
 */

// Cells. The server clamps to the same range (routes/scenes.js sanitizeToken),
// so a value outside it can't be saved and shouldn't be offered.
const SIZE_MIN = 0.5;
const SIZE_MAX = 10;

// What the stylesheet draws when no border colour has been chosen. Offered as
// the starting point when someone turns the ring on, so the first thing they
// see is roughly what was already there.
const DEFAULT_BORDER = '#0d1017';

// An untouched stat field is null, not zero. The server reads it the same way.
const blankToNull = (v) => (String(v).trim() === '' ? null : Number(v));

/**
 * What a token can be suffering from.
 *
 * The 5e condition list, plus Normal for a creature suffering from nothing -
 * which is what a token with no status stored is, and is why "no status" and
 * "Normal" are the same answer rather than two.
 *
 * Sorted here rather than written in order, so that adding one later is a
 * matter of putting it in the list and not of finding its slot. Custom is kept
 * out of the sort and appended: it is not a condition but a way of naming one
 * this list does not have, and it belongs at the end whatever it is called.
 */
const CUSTOM = 'Custom';
const CONDITIONS = [
  'Blinded',
  'Charmed',
  'Deafened',
  'Exhausted',
  'Frightened',
  'Grappled',
  'Incapacitated',
  'Invisible',
  'Normal',
  'Paralyzed',
  'Petrified',
  'Poisoned',
  'Prone',
  'Restrained',
  'Stunned',
  'Unconscious',
].sort((a, b) => a.localeCompare(b));

// The one that means "nothing wrong with it", which is what an empty status is.
const NORMAL = 'Normal';

/**
 * The stored status, read back into the two controls that produce it.
 *
 * Stored as a single string, so the map has nothing to interpret: whatever is
 * in there is what the tooltip prints. That leaves this the only place the
 * string has to be taken apart again - a known condition selects itself, empty
 * is Normal, and anything else was typed by somebody and belongs in the custom
 * box with Custom chosen above it.
 */
function statusParts(stored) {
  const value = String(stored ?? '').trim();
  if (!value) return { status: NORMAL, custom: '' };
  // The bare word, which is what an unnamed Custom is saved as. It picks Custom
  // with an empty box rather than reading as a custom status called "Custom",
  // which would be the same thing said more confusingly.
  if (value === CUSTOM) return { status: CUSTOM, custom: '' };
  if (CONDITIONS.includes(value)) return { status: value, custom: '' };
  return { status: CUSTOM, custom: value };
}

/**
 * The two controls back into the one string, which is the inverse of the above.
 *
 * Normal is stored as nothing at all rather than as the word. A token nobody
 * has ever asked about and one somebody has looked at and judged fine are in
 * the same state, and the map draws both the same way; storing the word would
 * make them different in the file and identical on screen, which is a
 * distinction nobody could ever act on.
 *
 * Custom with an empty box falls back to the bare word rather than refusing the
 * form. Somebody who picks Custom and types nothing has still said something -
 * that this token is under *something* the list does not name - and losing the
 * whole save over the missing word would be the worse answer.
 */
function statusValue(status, custom) {
  if (status === NORMAL) return '';
  if (status === CUSTOM) return custom.trim() || CUSTOM;
  return status;
}

// The total, when both halves are there to add up. Half a breakdown settles no
// tie, so it counts for nothing until the other half arrives.
function rolledTotal(die, mod) {
  const d = blankToNull(die);
  const m = blankToNull(mod);
  return d === null || m === null || Number.isNaN(d) || Number.isNaN(m) ? null : d + m;
}

/**
 * `stats` decides whether this form is about a token in play or a token in the
 * cast list. On the tabletop it asks for everything; in the campaign's Tokens
 * tab it asks for what a token *is* and leaves out what a token is *doing* -
 * hit points and initiative are decided in the moment by whoever is looking at
 * the fight, and a form you fill in before the session has no business holding
 * them. `canAssign` is the DM's: handing a token to somebody is theirs alone.
 */
export default function TokenModal({
  token,
  players = [],
  stats = true,
  canAssign = true,
  title,
  onSubmit,
  onClose,
}) {
  const editing = Boolean(token);
  const [label, setLabel] = useState(token?.label ?? 'NPC');
  // Whether the name is written on the board under the token, or only shown
  // when somebody hovers it. Off unless the token says otherwise, which covers
  // both a new token and every token made before this existed.
  const [showNameplate, setShowNameplate] = useState(token?.showNameplate === true);
  const [color, setColor] = useState(token?.color ?? '#e5534b');
  // Null is a real value here, not a missing one: it means "leave the ring as
  // the stylesheet draws it" rather than any particular colour.
  const [borderColor, setBorderColor] = useState(token?.borderColor ?? null);
  const [imageUrl, setImageUrl] = useState(token?.imageUrl ?? '');
  const [size, setSize] = useState(token?.size ?? 1);
  /**
   * Whose token this is, and therefore who may drag it.
   *
   * The empty string is "nobody" rather than null so the select has a value to
   * match against - it becomes null again on the way out. Null is what the
   * server stores for a token the DM keeps: the monsters, the doors, the pile
   * of crates.
   */
  const [ownerId, setOwnerId] = useState(token?.ownerId ?? '');
  // Kept as the strings the inputs hold rather than as numbers: blank is a
  // meaningful answer here - "not tracking this" - and Number('') is 0, which
  // would quietly turn an empty box into a token with no hit points left.
  const [initiative, setInitiative] = useState(token?.initiative ?? '');
  // The two halves behind that total. Kept so a tie can be settled by the
  // bigger modifier - with only the total, two creatures on 25 are simply
  // 25 and 25.
  const [initDie, setInitDie] = useState(token?.initiativeDie ?? '');
  const [initMod, setInitMod] = useState(token?.initiativeMod ?? '');
  const [hp, setHp] = useState(token?.hp ?? '');
  const [maxHp, setMaxHp] = useState(token?.maxHp ?? '');
  // The condition it is under, split into the two controls that say it: the
  // list, and the box that only matters when the list says Custom.
  const [status, setStatus] = useState(() => statusParts(token?.status).status);
  const [customStatus, setCustomStatus] = useState(() => statusParts(token?.status).custom);
  // And whether that condition is written on the board, which is a separate
  // question from whether the name is: a monster whose name would give the game
  // away can still usefully show that it is stunned.
  const [showStatus, setShowStatus] = useState(token?.showStatus === true);
  const [uploading, setUploading] = useState(false);
  // Whether the library is open over this form. One at a time: the browser is
  // the whole dialog while it's up, because a grid of tokens needs the room.
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);

  // Non-null once both halves are filled in, at which point it replaces the
  // total field rather than sitting beside it - two editable numbers that are
  // supposed to add up to a third invite them to disagree.
  const rolled = rolledTotal(initDie, initMod);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // Escape closes the thing in front. With the library open that's the
      // library - losing a half-filled form because you were done browsing
      // would be a poor trade.
      if (browsing) setBrowsing(false);
      else onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, browsing]);

  /**
   * Put the chosen file on the server and keep the URL it comes back with.
   *
   * Uploaded on pick rather than on save, so the preview below is the real
   * image at its real address - not a blob URL that would have to be swapped
   * for the true one later. The cost is an orphaned file if the form is then
   * cancelled, which is a few kilobytes on the host's own disk.
   */
  async function pickImage(file) {
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const { url } = await api.uploadImage(file);
      setImageUrl(url);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      // Clear the input, or choosing the same file twice in a row is silent.
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function submit(e) {
    e.preventDefault();
    if (busy || uploading) return;
    setBusy(true);
    setError('');
    try {
      // An unnamed token is still a token - fall back rather than refuse, since
      // the name is the least important thing about a blob you're about to drag
      // somewhere. It's still worth having with a picture on: it's what the
      // tooltip says, and what the chat calls it.
      await onSubmit({
        label: label.trim() || 'Token',
        showNameplate,
        status: statusValue(status, customStatus),
        showStatus,
        color,
        borderColor,
        size,
        imageUrl,
        initiative: rolled === null ? blankToNull(initiative) : rolled,
        initiativeDie: blankToNull(initDie),
        initiativeMod: blankToNull(initMod),
        hp: blankToNull(hp),
        maxHp: blankToNull(maxHp),
        // Back to null for "nobody" - the server reads a falsy owner as a token
        // that belongs to the table rather than to a person.
        ownerId: ownerId || null,
      });
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <>
      <div
        className="modal-backdrop"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <form
          className="modal token-form"
          role="dialog"
          aria-modal="true"
          aria-label={title || (editing ? 'Edit token' : 'Create token')}
          onSubmit={submit}
        >
          <div className="modal-head">
            <h2>{title || (editing ? 'Edit token' : 'Create token')}</h2>
            <button type="button" className="linky" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>

          <label className="token-field">
            Name
            <input
              autoFocus
              value={label}
              maxLength={60}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="NPC"
            />
          </label>

          {/* Directly under the name, and aligned under the box it is about
            rather than out in the label column: it decides whether that word is
            on the board all the time or only when somebody points at it. Off by
            default - a map where every token is captioned is a map you cannot
            see, and the tooltip has always been there for the rest. */}
          <label className="token-field token-check">
            <span>
              <input
                type="checkbox"
                checked={showNameplate}
                onChange={(e) => setShowNameplate(e.target.checked)}
              />
              Show on map
            </span>
          </label>

          {/* The one field that hands something over. Everything else here is
            what a token looks like; this is who may move it, and it is the
            difference between a board the DM drives and a table people play at.

            Listed by shown name, with the DM in the list too: a DM's own
            character is a token they'd want to own as a person rather than as
            the table, and the rule that follows is the same either way. */}
          {canAssign && (
            <label className="token-field">
              Belongs to
              <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                <option value="">Nobody - the DM moves it</option>
                {players.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.role === 'dm' ? ' (DM)' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}

          {/* Left blank on the tokens nobody rolls for - scenery, a door, a pile
            of crates. An empty stat prints no line in the tooltip at all.

            Two halves rather than one number, because a tie is settled by the
            modifier: 25 and 25 are the same, but 18+7 beats 22+3. Fill both and
            the total is worked out for you; fill neither and you can still type
            a bare total, which is what the tokens made before this had. */}
          {stats && (
            <div className="token-field">
              <span>Initiative</span>
              <span className="token-stat">
                {rolled === null ? (
                  <input
                    type="number"
                    value={initiative}
                    onChange={(e) => setInitiative(e.target.value)}
                    placeholder="-"
                    aria-label="Initiative total"
                  />
                ) : (
                  <output className="token-total">{rolled}</output>
                )}
                <small>=</small>
                <input
                  type="number"
                  value={initDie}
                  onChange={(e) => setInitDie(e.target.value)}
                  placeholder="die"
                  aria-label="Initiative die roll"
                />
                <small>+</small>
                <input
                  type="number"
                  value={initMod}
                  onChange={(e) => setInitMod(e.target.value)}
                  placeholder="mod"
                  aria-label="Initiative modifier"
                />
              </span>
            </div>

          )}

          {/* Two controls, so not a <label>: it can only speak for the first. */}
          {stats && (
            <div className="token-field">
              <span>Hit points</span>
              <span className="token-stat">
                <input
                  type="number"
                  min={0}
                  value={hp}
                  onChange={(e) => setHp(e.target.value)}
                  placeholder="-"
                  aria-label="Current hit points"
                />
                <small>out of</small>
                <input
                  type="number"
                  min={0}
                  value={maxHp}
                  onChange={(e) => setMaxHp(e.target.value)}
                  placeholder="-"
                  aria-label="Total hit points"
                />
              </span>
            </div>
          )}

          {/* Not a label, by the same rule as the border row below: once Custom
            is chosen this is two controls, and one label can only speak for the
            first of them.

            Offered here rather than inside the stats block above, so a token
            being prepared in the Tokens tab can be given one too. It costs
            nothing there and saves editing the token again the moment it lands
            on a map. */}
          <div className="token-field">
            <span>Status</span>
            <span className="token-status">
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                aria-label="Condition this token is under"
              >
                {CONDITIONS.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
                <option value={CUSTOM}>{CUSTOM}</option>
              </select>
              {/* Only with Custom chosen, because until then there is nothing for
                it to name. Left empty it is not an error: the token simply
                reads as "Custom", which is a truthful enough answer to what is
                wrong with it and better than refusing to save the form. */}
              {status === CUSTOM && (
                <input
                  value={customStatus}
                  maxLength={40}
                  onChange={(e) => setCustomStatus(e.target.value)}
                  placeholder={CUSTOM}
                  aria-label="Name for this custom status"
                />
              )}
            </span>
          </div>

          {/* The same offer the name gets, in the same words and the same place
              under its own field: put this on the board, or leave it to the
              hover. The two are independent - a monster whose name is a spoiler
              can still show that it is stunned - and the map puts together
              whichever of them are asked for. */}
          <label className="token-field token-check">
            <span>
              <input
                type="checkbox"
                checked={showStatus}
                onChange={(e) => setShowStatus(e.target.checked)}
              />
              Show on map
            </span>
          </label>

          <label className="token-field">
            Colour
            <span className="token-colour">
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
              <code>{color}</code>
            </span>
          </label>

          {/* Not a label: the checkbox and the colour well are two controls, and
            one label can only speak for the first of them. */}
          <div className="token-field">
            <span>Border</span>
            <span className="token-colour">
              <input
                type="checkbox"
                checked={borderColor !== null}
                onChange={(e) => setBorderColor(e.target.checked ? DEFAULT_BORDER : null)}
                aria-label="Give this token a coloured border"
              />
              {borderColor === null ? (
                <small>Default dark ring</small>
              ) : (
                <>
                  <input
                    type="color"
                    value={borderColor}
                    aria-label="Border colour"
                    onChange={(e) => setBorderColor(e.target.value)}
                  />
                  <code>{borderColor}</code>
                </>
              )}
            </span>
          </div>

          {/* Two ways to the same field. The library is offered first because it
            is the answer almost every time - a couple of thousand pictures are
            already here, and uploading is for the one your table needs that
            isn't. */}
          <div className="token-field">
            <span>Picture</span>
            <span className="token-image">
              <button type="button" onClick={() => setBrowsing(true)}>
                Choose from library
              </button>
              {uploading && <small>Uploading…</small>}
              {/* Removing it puts the name back - the picture stands in for the
                name rather than sitting alongside it. */}
              {imageUrl && !uploading && (
                <button type="button" className="linky" onClick={() => setImageUrl('')}>
                  Remove
                </button>
              )}
            </span>
          </div>

          <div className="token-field">
            <span>Or upload</span>
            <span className="token-image">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                disabled={uploading}
                onChange={(e) => pickImage(e.target.files?.[0])}
              />
              {/* The same act by another road: a picture that is already on the
                clipboard has nowhere on disk to be chosen from, and saving it
                out just to pick it up again is a step for the sake of one. */}
              <ClipboardImage onImage={pickImage} disabled={uploading} />
            </span>
          </div>

          {/* The three appearance choices only mean something together, so show
            the token itself rather than asking anyone to picture it. */}
          <div className="token-field">
            <span>Preview</span>
            <span
              className="token-preview"
              style={{
                background: imageUrl ? `center / cover no-repeat url(${JSON.stringify(imageUrl)})` : color,
                ...(borderColor ? { borderColor } : {}),
              }}
            >
              {!imageUrl && <span className="token-label">{label.trim() || 'Token'}</span>}
            </span>
          </div>

          <label className="token-field">
            Size
            <span className="token-size">
              <input
                type="range"
                min={SIZE_MIN}
                max={SIZE_MAX}
                step={0.5}
                value={size}
                onChange={(e) => setSize(Number(e.target.value))}
              />
              {/* In cells, because that's the unit the map is measured in - "2"
                means it covers two squares across, not two of anything else. */}
              <small>{size} {size === 1 ? 'cell' : 'cells'} across</small>
            </span>
          </label>

          {error && <p className="error">{error}</p>}

          <div className="modal-actions">
            <button type="button" className="linky" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={busy || uploading}>
              {busy ? 'Saving…' : editing ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
      </div>

      {/* A sibling of the form rather than a child of it: a dialog nested inside
        a <form> would be markup that only accidentally works, and this needs
        the whole screen anyway. */}
      {browsing && (
        <div
          className="modal-backdrop token-picker-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setBrowsing(false);
          }}
        >
          <div className="modal token-picker" role="dialog" aria-modal="true" aria-label="Choose a token picture">
            <div className="modal-head">
              <h2>Choose a picture</h2>
              <button type="button" className="linky" onClick={() => setBrowsing(false)} aria-label="Close">
                ✕
              </button>
            </div>
            <TokenLibrary
              selectedUrl={imageUrl}
              onPick={(file) => {
                setImageUrl(file.url);
                setBrowsing(false);
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}
