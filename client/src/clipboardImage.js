// Taking a picture out of the clipboard, for every place the app accepts one.
//
// Kept apart from the button that calls it for the usual reason: this is the
// awkward part - a browser API with three different ways of saying no - and the
// awkward part is the part worth being able to read on its own.
//
// Nothing here talks to the server. It hands back a File, which is exactly what
// a file input would have handed over, so every caller carries on doing what it
// already did with an upload.

/**
 * What the server will actually keep, and the extension for each.
 *
 * The same four as the upload route, deliberately: an image this let through
 * that the server then refused would be a button that fails after the work.
 * See server/routes/uploads.js, which sniffs the bytes and has the final say.
 */
const ACCEPTED = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
]);

/**
 * The two ways this can fail, which are two different problems.
 *
 * One is about what you copied: there is a clipboard, we read it, and it holds
 * no picture. The other is about the browser: it would not let us look at all,
 * because permission was refused or the page is not on a secure origin. Telling
 * somebody their clipboard content is invalid when the truth is that nobody
 * looked would send them off to copy the image again, which cannot help.
 */
export const CLIPBOARD_INVALID = 'Invalid clipboard content';
export const CLIPBOARD_BLOCKED = 'Clipboard blocked by the browser';

/**
 * Read the clipboard and give back an image file, or say why not.
 *
 * Returns `{ file }` or `{ error }`. Must be called from a click: browsers only
 * hand over the clipboard on a gesture, and one asked for out of the blue is
 * refused whatever the permission says.
 *
 * A clipboard item can offer the same picture in several formats at once - a
 * screenshot copied on Windows commonly arrives as both PNG and a bitmap - so
 * this takes the first format it recognises rather than insisting on one.
 */
export async function imageFromClipboard() {
  if (!navigator.clipboard?.read) return { error: CLIPBOARD_BLOCKED };

  let items;
  try {
    items = await navigator.clipboard.read();
  } catch {
    // Denied, dismissed, or an insecure origin. They arrive as different
    // exceptions and mean the same thing here: we never saw the clipboard, so
    // we have nothing to say about what is in it.
    return { error: CLIPBOARD_BLOCKED };
  }

  for (const item of items) {
    const type = item.types?.find((t) => ACCEPTED.has(t));
    if (!type) continue;
    try {
      const blob = await item.getType(type);
      // An empty blob is not a picture. Keep looking rather than failing here:
      // there may be another item behind this one that is.
      if (!blob?.size) continue;
      const name = `clipboard-${Date.now()}.${ACCEPTED.get(type)}`;
      // A File rather than the Blob itself, because the upload goes out as
      // multipart and multipart wants a filename. The server ignores it and
      // generates its own - see the note there about "../../index.js" - so this
      // is only ever what the request calls the part.
      return { file: new File([blob], name, { type }) };
    } catch {
      // This item promised a type it can't produce. Try the next one.
    }
  }

  return { error: CLIPBOARD_INVALID };
}
