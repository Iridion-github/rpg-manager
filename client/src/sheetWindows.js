/**
 * "Open that character's sheet" - asked from anywhere, answered in one place.
 *
 * The sheets are drawn by CharacterSheets, which is mounted for the whole
 * campaign rather than only under its own tab, precisely so an open sheet can
 * float over the map. That makes "open this one" a thing worth being able to
 * ask for from the map - from the token form, where a figure names the
 * character it is holding.
 *
 * A module rather than props threaded through App, for the same reason
 * history.js is one: the two components are siblings, neither owns the other,
 * and the alternative is a command prop that App has to set and somebody has to
 * remember to clear - which then cannot ask for the same sheet twice in a row,
 * because setting a state to the value it already holds changes nothing and
 * fires no effect. A function call has no such trouble.
 *
 * One provider at a time, which is what is actually mounted: CharacterSheets is
 * keyed by campaign, so leaving a table unregisters the old one before the new
 * one arrives. Asking when nobody is listening does nothing rather than
 * throwing - the button that asks is only drawn when `canOpenSheet` says there
 * is somebody there to answer.
 */

let opener = null;

/**
 * Register the thing that knows how to open a sheet. Returns the unregister,
 * so a caller can hand this straight back out of a useEffect.
 */
export function provideSheetOpener(fn) {
  opener = fn;
  return () => {
    // Only if it is still ours: on a campaign change React may mount the new
    // provider before unmounting the old one, and the old one's cleanup must
    // not take the new one down with it.
    if (opener === fn) opener = null;
  };
}

export const canOpenSheet = () => Boolean(opener);

export function openCharacterSheet(sheetId) {
  if (sheetId) opener?.(sheetId);
}
