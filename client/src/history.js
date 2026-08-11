// Undo and redo, for the things *you* did.
//
// Two halves make that promise good. The first is here: the stack lives in this
// browser tab and nothing writes to it but the action that made it, so there is
// no way to reach somebody else's change from this list — it was never put in
// it. The second is in the entries themselves (sceneHistory.js), which check
// that what they are about to reverse is still as they left it, and refuse when
// it isn't. Without that a table where two people move the same token would let
// your Ctrl+Z quietly undo their move on top of yours.
//
// Nothing is persisted, deliberately. An entry is a promise that something can
// be put back, and across a reload — or a switch to another table — that is a
// promise this can no longer keep.

// Deep enough to cover a session's worth of mistakes, shallow enough that the
// oldest entries are gone long before anyone tries to reverse a board that has
// moved on entirely.
const LIMIT = 50;

const done = []; // oldest first — Undo takes the last
const undone = []; // what Redo takes, likewise
const listeners = new Set();

// One reversal at a time. Two overlapping ones would race for the same board,
// and a held-down Ctrl+Z fires the keystroke over and over.
let running = false;

function notify() {
  for (const fn of listeners) fn();
}

/** Called whenever the two stacks change. Returns its own unsubscribe. */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const canUndo = () => !running && done.length > 0;
export const canRedo = () => !running && undone.length > 0;

/**
 * Remember an action, given as the two calls that reverse and reapply it.
 *
 * `{ label, sceneId, undo, redo }` — the label names the action for an error
 * message, and the scene is what to look at afterwards, so an undo on a board
 * you aren't watching doesn't look like a button that did nothing.
 */
export function record(entry) {
  done.push(entry);
  if (done.length > LIMIT) done.shift();
  // Doing something new is a new branch of history: what was undone before it
  // can no longer be put back in an order that would mean anything.
  undone.length = 0;
  notify();
}

/** Forget everything — on leaving a table, whose actions these were. */
export function clear() {
  done.length = 0;
  undone.length = 0;
  notify();
}

/**
 * An error saying the board has moved on: what this entry describes is no
 * longer the thing that's there, so reversing it would be reversing someone
 * else's work rather than your own. Marked so `run` knows to drop the entry
 * instead of leaving it to fail again.
 */
export function stale(message) {
  const err = new Error(message);
  err.stale = true;
  return err;
}

async function run(from, to, direction) {
  if (running) return null;
  const entry = from[from.length - 1];
  if (!entry) return null;
  running = true;
  notify(); // the buttons go quiet while it runs
  try {
    await entry[direction]();
  } catch (err) {
    running = false;
    // Stale: this action is not ours to reverse any more, so it leaves the
    // history rather than sitting at the top of it failing forever. Anything
    // else — a dropped connection, a server that said no — is worth another
    // go, so the entry stays exactly where it was.
    if (err?.stale) from.pop();
    notify();
    throw err;
  }
  from.pop();
  to.push(entry);
  running = false;
  notify();
  return entry;
}

/** Reverse the last action. Resolves with the entry, or null if there was none. */
export const undo = () => run(done, undone, 'undo');

/** Put back the last thing Undo took. */
export const redo = () => run(undone, done, 'redo');
