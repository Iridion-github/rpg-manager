/**
 * Somebody's face, wherever their name appears.
 *
 * Small, round, and never absent: an account with no picture gets the first
 * letter of its name on its own colour, so a list of people is a column of the
 * same shape whether or not anybody has uploaded anything. A gap that appears
 * only for some rows would make the list jump about as pictures were added.
 *
 * `color` is the colour the server already gave that person for their token. It
 * rings the picture and fills in behind the letter, so the same colour that
 * marks them on the map marks them in a list - which is what lets this stand in
 * for the plain swatch it replaced without losing what the swatch said.
 */
export default function Avatar({ url, name = '', color, big = false }) {
  const initial = (name.trim()[0] || '?').toUpperCase();
  return (
    <span
      className={`avatar${big ? ' big' : ''}`}
      style={{
        ...(url ? null : { background: color || '#3a4152' }),
        ...(color ? { borderColor: color } : null),
      }}
      title={name}
    >
      {url ? <img src={url} alt="" /> : initial}
    </span>
  );
}
