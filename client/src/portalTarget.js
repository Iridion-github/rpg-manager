import { createContext, useContext } from 'react';

/**
 * Which document a dialog should be drawn into.
 *
 * Almost everything in this app that floats - every confirm box, every picker,
 * the roll dialog - portals itself into `document.body` rather than rendering
 * where it was called from, because a fixed-position thing has no business in
 * the middle of a column's child list. That was one answer for as long as there
 * was one document.
 *
 * A window popped out to the desktop (see PopoutWindow.jsx) is a second one.
 * Its contents are still part of this React tree - same state, same sockets,
 * same everything - but their DOM lives in another window, and a dialog opened
 * from a character sheet on the second monitor that appears back on the first
 * is worse than useless: it is a question nobody can see being asked.
 *
 * So the target is context rather than a constant. The default is the page's
 * own body, which is what every caller outside a popped-out window gets and is
 * exactly what they had before; PopoutWindow provides its own body to
 * everything inside it.
 */
const PortalTarget = createContext(null);

export const PortalTargetProvider = PortalTarget.Provider;

/**
 * Where to portal to.
 *
 * Falls back to `document.body` rather than requiring a provider, so a
 * component can be rendered anywhere without knowing whether it happens to be
 * inside a popped-out window. Read at render time and not cached: a window
 * that is put back on the page must send the next dialog to the page.
 */
export function usePortalTarget() {
  return useContext(PortalTarget) || document.body;
}
