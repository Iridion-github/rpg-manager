// Textarea heights, remembered per sheet.
//
// Every box of prose on a character sheet has a grab handle in its corner, and
// the height somebody drags it to is a fact about how they read that character:
// a two-line backstory and a two-page one want different boxes, and being made
// to drag the same one open every time the sheet is opened is the sort of small
// tax that makes a sheet feel like a form.
//
// In localStorage rather than on the sheet itself, alongside the window opacity
// and the rest of the per-reader settings: how tall a box is drawn is a fact
// about a reader's screen, not about the character, and the DM dragging a
// player's backstory open has no business changing what that player sees.
//
// Only the height is kept. The stylesheet gives every textarea `width: 100%`
// and `resize: vertical`, so the width is the column's and there is nothing in
// it to remember.

import { createContext, useCallback, useContext, useEffect, useRef } from 'react';

const SheetIdContext = createContext('');

const storeKey = (sheetId) => `rpg:sheet-areas:${sheetId}`;

// What has been read out of storage this session, by sheet. Every box on the
// page asks for the same blob when it mounts, and a page of Details is a dozen
// of them; parsing it once is enough.
const cache = new Map();

function sizesFor(sheetId) {
  if (cache.has(sheetId)) return cache.get(sheetId);
  let sizes = {};
  try {
    const raw = localStorage.getItem(storeKey(sheetId));
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') sizes = parsed;
  } catch {
    // Unreadable or unparseable. The boxes open at their written height, which
    // is what they did before any of this existed.
  }
  cache.set(sheetId, sizes);
  return sizes;
}

// Dragging a handle reports a new size every frame. The blob is written once
// the drag has settled instead, so a slow pull down a long page is one write
// rather than sixty.
const pending = new Map();
let flushTimer = 0;

function flush() {
  flushTimer = 0;
  for (const [sheetId, patch] of pending) {
    const sizes = { ...sizesFor(sheetId), ...patch };
    cache.set(sheetId, sizes);
    try {
      localStorage.setItem(storeKey(sheetId), JSON.stringify(sizes));
    } catch {
      // Private mode, or a full quota. The box still resizes; it just won't be
      // that size the next time the sheet is opened.
    }
  }
  pending.clear();
}

function remember(sheetId, name, height) {
  pending.set(sheetId, { ...(pending.get(sheetId) || {}), [name]: height });
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 250);
}

/**
 * Which sheet the boxes underneath belong to.
 *
 * Wrapped round the whole sheet rather than passed down through the pages,
 * because the boxes that want it are five components deep and every one of the
 * layers between them has nothing to do with it.
 */
export function SheetAreaSizes({ sheetId, children }) {
  return <SheetIdContext.Provider value={sheetId || ''}>{children}</SheetIdContext.Provider>;
}

/**
 * A ref for a textarea whose height should outlive the window it is in.
 *
 * `name` is what the height is filed under, and has to mean the same thing the
 * next time the sheet is opened: a field's own key for the boxes that are part
 * of the sheet, and the row's id for the ones that belong to a row.
 *
 * Handing back nothing useful outside a sheet is deliberate rather than a
 * failure. The same attack row is drawn in the token dialog and the same item
 * rows in the compendium preview, where there is no sheet whose heights these
 * would be, and those boxes simply behave as they always have.
 */
export function useAreaSize(name) {
  const sheetId = useContext(SheetIdContext);
  const observerRef = useRef(null);
  // The height last written down, so that the width changing - which is what
  // happens when the window round the sheet is dragged wider - is not mistaken
  // for somebody resizing the box.
  const heightRef = useRef(null);

  const stop = () => {
    observerRef.current?.disconnect();
    observerRef.current = null;
  };

  useEffect(() => stop, []);

  return useCallback(
    (node) => {
      stop();
      heightRef.current = null;
      if (!node || !sheetId || !name) return;

      const saved = Number(sizesFor(sheetId)[name]);
      if (Number.isFinite(saved) && saved > 0) {
        node.style.height = `${saved}px`;
        heightRef.current = saved;
      }

      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(() => {
        const height = Math.round(node.getBoundingClientRect().height);
        // Nought means the page it is on is hidden rather than that somebody
        // dragged the box shut.
        if (!height) return;
        // The observer's first call is the height the box already had, which is
        // not news; only what happens to it afterwards is.
        if (heightRef.current === null) {
          heightRef.current = height;
          return;
        }
        if (height === heightRef.current) return;
        heightRef.current = height;
        remember(sheetId, name, height);
      });
      observer.observe(node);
      observerRef.current = observer;
    },
    [sheetId, name],
  );
}
