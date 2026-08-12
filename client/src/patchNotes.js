// What has changed, in the order it changed, for the people who use this.
//
// Written by hand rather than generated from the git log, and that is the whole
// point of the file. A commit message is a note from one developer to another —
// "Fix token update bug" tells a player nothing, and "WIP" tells them less. This
// says what is different at their table. When two commits are really one change,
// they get one line; when a commit changed nothing anybody can see, it gets
// none.
//
// ---
//
// **Adding an entry.** Put it at the top. If today's date is already the first
// group, add a line to it; otherwise start a new group above the last one. One
// group per day, newest first — the screen renders them in the order they
// appear here and does no sorting of its own, so the order in this file is the
// order on the page.
//
//   kind — 'new' for a feature, 'fix' for something that was broken,
//          'change' for something that already worked and now works differently.
//   text — one or two sentences, in the second person, about what somebody can
//          now do. Not how it was built.
//
// Dates are ISO so they sort and parse unambiguously; the screen formats them.

export const PATCH_NOTES = [
  {
    date: '2026-08-12',
    entries: [
      {
        kind: 'new',
        text: 'Characters and tokens can be coupled, from either the Characters tab or the Tokens tab. Linked, the two share hit points in both directions — damage on the map lands on the sheet, healing on the sheet shows on the map — and the token takes its initiative modifier from the character. Its name, picture and size stay its own. One character per token and one token per character; you can couple your own, and the DM can couple anything.',
      },
      {
        kind: 'new',
        text: 'Patch notes — this page. Every change worth knowing about, newest first.',
      },
      {
        kind: 'new',
        text: 'Character sheets belong to people now. Anyone at the table can make one and it is theirs immediately; the DM can hand any sheet to any player as view-only or fully editable, and take it back again — it disappears from their screen at once. Players see only the characters that are theirs, and the DM sees them all with a note of who holds each.',
      },
      {
        kind: 'new',
        text: 'Measuring mode, in the map\'s Tools panel. Click to drop points and read the distance along each leg and for the whole route, in cells, feet or metres. Diagonals count the 5e way. Tick Shared and the rest of the table can watch you measure; leave it off and nobody sees a thing.',
      },
      {
        kind: 'new',
        text: 'Forgotten your password? on the sign-in screen. It posts a link to the address on your account, and the link lets you choose a new password. An account with no address on file can get one from the server admin instead.',
      },
      {
        kind: 'new',
        text: 'Tokens can be assigned to players. A token with an owner can be dragged by that player, carries a pip in their colour, and can be prepared in advance from the Tokens tab and placed on any map when you need it.',
      },
      {
        kind: 'fix',
        text: 'Editing a token from the Tokens tab no longer forgets things. Removing a border in particular was accepted and then quietly ignored, so the colour came straight back.',
      },
      {
        kind: 'fix',
        text: 'Your own tokens no longer draw a white ring inside them. On a token with a colour of its own it looked like a second border.',
      },
      {
        kind: 'fix',
        text: 'Registering without an email address works again, and the token list no longer fails to load over a slow connection.',
      },
    ],
  },
  {
    date: '2026-08-11',
    entries: [
      {
        kind: 'new',
        text: 'A drawing layer on the map: rectangles, circles, cones and lines, for marking where a spell lands or where you mean to run. Drag one out, then tune its size, colour and angle. Anyone playing can draw, and what you drew stays yours to change.',
      },
      {
        kind: 'new',
        text: 'Undo and redo, on Ctrl+Z and Ctrl+Shift+Z or from the map\'s right-click menu. It reaches your own changes only, and refuses politely if somebody else has moved the thing you were about to put back.',
      },
      {
        kind: 'new',
        text: 'A token library of ready-made artwork, searchable, so most creatures no longer need an upload.',
      },
      {
        kind: 'new',
        text: 'Campaigns can be exported to a file and imported back, which is also how you move a table to another machine or keep a backup.',
      },
      {
        kind: 'new',
        text: 'Email. Changing your password or your address is confirmed by a link sent to you, so a browser somebody left open is not enough to take an account over.',
      },
      {
        kind: 'new',
        text: 'A Users tab listing everyone on the server, with a green or red dot for who is connected and when each was last online.',
      },
      {
        kind: 'new',
        text: 'The grid can be slid over a map that already has one drawn on it: pick the Grid gauge and right-drag. Tokens and shapes ride along with it.',
      },
      {
        kind: 'new',
        text: 'Floating windows — sheets, the turn tracker, the drawing box — have an opacity slider, so you can keep one over the map and still see the map.',
      },
      {
        kind: 'change',
        text: 'The chat column is half again as wide, and a general tidy-up of spacing and colour throughout.',
      },
      {
        kind: 'fix',
        text: 'Tokens no longer dash across the board when you zoom, drawing mode behaves itself, and the tabletop has a d20 for a favicon so its tab is findable.',
      },
    ],
  },
  {
    date: '2026-08-10',
    entries: [
      {
        kind: 'new',
        text: 'Hovering a token tells you about it — name, hit points and initiative, showing each person only what they are entitled to see.',
      },
      {
        kind: 'new',
        text: 'Notes and handouts grew up: the DM writes them, and shares the ones the table is meant to read.',
      },
      {
        kind: 'change',
        text: 'A security pass over the whole server. Repeated wrong guesses at a password or a signup code are slowed down, uploads are checked properly rather than trusted, and the browser is told to be stricter about what the page may do.',
      },
    ],
  },
  {
    date: '2026-08-09',
    entries: [
      {
        kind: 'new',
        text: 'Right-click menus on the map. Ping a spot so it pulses on everyone\'s screen, pull the whole table\'s view to where you are pointing, and create or edit a token where you clicked.',
      },
      {
        kind: 'new',
        text: 'A proper form for making a token: name, colour, size and picture, with a preview.',
      },
      {
        kind: 'new',
        text: 'A server admin, distinct from any campaign\'s DM, who manages accounts and has no standing at anybody\'s table.',
      },
    ],
  },
  {
    date: '2026-08-08',
    entries: [
      {
        kind: 'new',
        text: 'Campaigns. The server holds several tables, each with its own maps, characters, notes and chat, and you are a DM at one and a player at another.',
      },
      {
        kind: 'new',
        text: 'Accounts: register, sign in, sign out. A campaign\'s DM chooses who sits at it.',
      },
      {
        kind: 'new',
        text: 'Character sheets, dice rolling with the results in chat, shared notes, and a music player for the table.',
      },
      {
        kind: 'change',
        text: 'Everything moved into a database instead of loose files — faster, and it stops two people saving at once from losing one of the changes. Existing data is carried over automatically.',
      },
      {
        kind: 'change',
        text: 'The app can be put online properly, and its data taken away with you.',
      },
    ],
  },
  {
    date: '2026-08-07',
    entries: [
      {
        kind: 'new',
        text: 'The first tabletop: a map with a grid, tokens you can drag, and everyone at the table watching them move as they move.',
      },
    ],
  },
];

/**
 * "12 August 2026". Written out rather than 12/08/2026, which means two
 * different days depending on who is reading it — and this list is read
 * top-to-bottom for *when*, so the one thing every line has to be unambiguous
 * about is its date.
 *
 * Parsed as UTC and formatted as UTC. A bare ISO date is midnight UTC, and
 * formatting that in a timezone behind it would print the day before.
 */
export function patchDate(iso) {
  const when = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(when.getTime())) return iso;
  return when.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** The newest date on the list, for the badge on the tab. */
export const latestPatchDate = PATCH_NOTES[0]?.date || '';
