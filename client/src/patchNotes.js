// What has changed, in the order it changed, for the people who use this.
//
// Written by hand rather than generated from the git log, and that is the whole
// point of the file. A commit message is a note from one developer to another -
// "Fix token update bug" tells a player nothing, and "WIP" tells them less. This
// says what is different at their table. When two commits are really one change,
// they get one line; when a commit changed nothing anybody can see, it gets
// none.
//
// ---
//
// **Adding an entry.** Put it at the top. If today's date is already the first
// group, add a line to it; otherwise start a new group above the last one. One
// group per day, newest first - the screen renders them in the order they
// appear here and does no sorting of its own, so the order in this file is the
// order on the page.
//
//   kind - 'new' for a feature, 'fix' for something that was broken,
//          'change' for something that already worked and now works differently.
//   text - one or two sentences, in the second person, about what somebody can
//          now do. Not how it was built.
//
// Dates are ISO so they sort and parse unambiguously; the screen formats them.

export const PATCH_NOTES = [
  {
    date: '2026-08-16',
    entries: [
      {
        kind: 'new',
        text: 'Tokens can be hidden from the table. Creating or editing one, the DM gets a Visible to players tick, on by default: turn it off and the token is theirs alone. It is not merely invisible on the players\' screens; their browsers are never told it exists, so there is nothing to find by poking about. It still stands on the board, still moves, still rolls initiative and still takes damage, and turning the tick back on puts it in front of everybody at once. Only the DM can set it, on any token, including one belonging to a player.',
      },
      {
        kind: 'new',
        text: 'A hidden token wears a crossed-out eye where its nameplate goes, so the DM can tell at a glance which of the figures on their board only they can see. If the token shows its name too, the eye sits just to the left of it. Its tooltip says so in words as well.',
      },
    ],
  },
  {
    date: '2026-08-15',
    entries: [
      {
        kind: 'new',
        text: 'Copy and paste a token. Right-click one of your own figures and choose Copy token, then right-click any empty spot on the map and choose Paste token: you get another one of it, exactly the same, standing where you pointed. It asks first and shows you what it is about to put down, because two goblins look alike and pasting the wrong one is easy. The copy is named after the original with a number in brackets - Ogre (Copy 1), then (Copy 2) - so you can tell four of them apart out loud. The clipboard keeps hold of whatever you copied, so laying out a whole warband is one right-click each, and copying something else replaces it. Everything comes across: the picture, the size, the colours, the condition, the hit points, the initiative and who it belongs to. The one thing that does not is the character sheet, since a character belongs to one figure; link the copy yourself if you want it to have one.',
      },
      {
        kind: 'new',
        text: 'A spell on your sheet is the whole spell now, not just its name. Open one with the little arrow beside it and write down its level, school, casting time, range, area, components (with the material ones spelled out when it needs them), duration, what it asks for as an attack or a save, what it does, and the description in full. Shut again, each spell shows a short line of what kind of magic it is, what it costs to cast and how far it reaches, so you can find the one you want without opening five of them.',
      },
      {
        kind: 'new',
        text: 'Spells roll their own dice. Set a to-hit and a damage on a spell the same way you do on an attack, tick Spell attack to have your proficiency and casting ability added for you, and the 🎲 beside the name throws them: one dialog, advantage and disadvantage where they mean something, DM only if you want it quiet, and whatever global modifiers you have running ride along and can be unticked for the one cast.',
      },
      {
        kind: 'new',
        text: 'Sharing mode gives you a spell as its entry. Click a spell and what goes to the chat is its level and school, the casting time, range, area and duration on one line, its components and materials, the save or attack, the damage, and the description underneath. Show the table what you are casting instead of reading it out.',
      },
      {
        kind: 'fix',
        text: 'Spell slots save. Typing how many slots you have at a level did nothing at all before: the box went back to zero the moment you looked away, and it wiped the number you had used along with it. Both numbers stick now, and the used count can no longer run past the slots you actually have.',
      },
      {
        kind: 'new',
        text: 'You can take a message back out of the chat. Right-click one of your own lines and choose Delete message, and it goes for everyone at the table straight away. The DM can do it to any message, not just their own; the menu only appears on a line you are allowed to remove. Anything posted before today has nobody\'s name attached to it in a way the server can check, so those are the DM\'s to tidy up.',
      },
      {
        kind: 'new',
        text: 'Sharing mode, on the top row of an open character sheet. Press Enter Sharing mode and the sheet lights up: click anything on it and a box shows you exactly what will appear in the chat. Send to chat posts it, Cancel takes you back with the mode still on, so you can show the table three things in a row. Nothing can be edited or rolled while the mode is on, so a click never lands in a text box by accident; Exit Sharing mode gives you the sheet back.',
      },
      {
        kind: 'change',
        text: 'What you share is one thing at a time: this saving throw, this skill, this item, this feature, this spell, this piece of armour. Nothing sends a whole section at once, because "here are all eighteen of my skills" is a wall of text nobody reads, and what actually gets said at a table is "my Stealth is +6". The boxes at the top of the sheet go the same way - your name, class, level, subclass, background, race, alignment, player and XP are nine separate things to send, not one block. So are hit points, hit dice and death saves, and so are Inspiration and your proficiency bonus.',
      },
      {
        kind: 'change',
        text: 'Other proficiencies & languages, Inventory, and Features & traits are lists now instead of one long box of text. Each entry is a row you fill in, add and throw away on its own: a proficiency has a title, an optional subtitle and an optional description; an inventory item has an optional quantity, a name and an optional weight; a feature has a title, where it came from, and what it does. Inventory adds up what you are carrying and prints the total beside the heading: the weight you write is what one of the thing weighs, so fifty arrows at 0.05 come to 2.5. Write no weights and there is no total, because a table that does not track encumbrance should not be shown a running one. Anything you had already typed into those three boxes is read back as rows - one per line, and for features one per paragraph with its first line as the title - so nothing is lost and there is nothing to copy across by hand.',
      },
      {
        kind: 'change',
        text: 'Personality traits, Ideals, Bonds, Flaws and Notes are still plain text boxes. They are places to write about your character rather than lists of things, so nothing about them has changed.',
      },
      {
        kind: 'change',
        text: 'A note is shared with the people you choose, not just with everybody. Open a note and the line above it asks who can read it: Private is yours alone, Public is everyone at the table including anyone who joins later, and Shared with… gives you a tick beside each person\'s name. Change it whenever you like - take a note back and it vanishes from their screen at once, even if they have it open. Notes you had already handed out are Public, and the rest are Private, which is exactly what they were before.',
      },
      {
        kind: 'change',
        text: 'A note belongs to whoever wrote it. Anybody you share one with can read it and nothing else, and that now holds for a second DM at the same table as well: they read your prep the way a player reads a handout, and only you can edit or delete it. Notes written before this belong to the DM\'s chair rather than to a person, so nothing you already had has become read-only.',
      },
      {
        kind: 'change',
        text: 'The chat announces a handout only when a note goes Public. Sharing one with two named people no longer tells the other five that something was handed out - it simply appears in the handouts of the people you picked.',
      },
    ],
  },
  {
    date: '2026-08-14',
    entries: [
      {
        kind: 'new',
        text: 'Your account has a profile picture. Open My account, choose a file or paste one you have copied, and it saves as soon as you have framed it - no button to press afterwards. It is square, and it appears beside your name in the bar at the top, in the server\'s list of people, and in the players at your table. Anybody without one gets their initial on their own token colour, so a list still reads as a column of faces. Remove takes it off again.',
      },
      {
        kind: 'new',
        text: 'Characters have a portrait, and it has proper room on the sheet: it stands at the top left beside the name, taller than it is wide, at the size a picture of somebody is actually worth looking at. The name, class, level, subclass, background, race, alignment, player and XP now spread out beside it to fill that height, in boxes like the ones on a printed sheet, rather than huddling in a line at the top. You set the portrait the same two ways as a profile picture - choose a file, or paste one you have copied. It also shows down the side of that character\'s card in the Characters tab, so you can find somebody by their face rather than by reading down the names. Anyone who can see a sheet but not change it sees the portrait without the buttons.',
      },
      {
        kind: 'new',
        text: 'Choosing any picture of a person now opens a framing box first. Drag the picture to slide it about, zoom in or out with the slider or your mouse wheel, and what you can see in the frame is exactly what gets saved - so a face is where you put it rather than wherever the middle of the photograph happened to be. The frame is square for a profile picture and upright for a character portrait, which is the shape each of them is shown in everywhere else.',
      },
      {
        kind: 'change',
        text: 'Pictures of people have a size limit: 5 MB for the file you pick. A photograph straight off a phone fits comfortably; anything larger is turned away the moment you pick it, before anything is uploaded, and the screen says how big it was. What actually gets saved is the part you framed, which is a good deal smaller again. Maps are unaffected and still take up to 20 MB.',
      },
      {
        kind: 'new',
        text: 'Edit is on the right-click menu of your own tokens now, not just the DM\'s. Right-click a figure that belongs to you on the map and you get the same form the Tokens tab gives you: its name, picture, colour, size, nameplate, status and hit points, without leaving the board. Who a token belongs to is still the DM\'s to set, so that one field is missing from your copy of the form. If your figure is linked to a character sheet you have not been given, the hit points stay the DM\'s too and the app tells you rather than pretending to save them.',
      },
      {
        kind: 'change',
        text: 'The token list has column headings and a line explaining them: Token, Linked to which Char Sheet, Assigned Player, and the buttons. The player a token belongs to is now shown in the list itself instead of tucked under its name, so you can read down the column and see who has what without opening anything. The old single "Character" caption read like a way of giving a token to a player, which it never was: that is Assigned Player, set under Edit, and it has no limit on how many you can hand out.',
      },
      {
        kind: 'change',
        text: 'The Characters tab says "Linked Token" now, rather than "Token", so it reads as the same question the Tokens tab asks from the other side. A character is on one figure and a figure is one character, as before: putting a character on a new figure takes it off the old one, and the dropdown tells you which character a figure is already carrying before you choose it.',
      },
      {
        kind: 'change',
        text: 'Make as many tokens as you want. The Tokens tab used to give you one and then take the button away; now anybody can make as many as they need, so a familiar, a summoned swarm and a horse are three figures on the table rather than a conversation about it. Your DM can hand out as many as they like too. A token still belongs to one person at a time, so giving one to somebody takes it off whoever had it.',
      },
      {
        kind: 'new',
        text: 'Equipped Armor, a new section on the character sheet. Write down each piece you own - a name, whether it is clothes, light, medium, heavy or a shield, its AC, how much Dexterity it lets through, and whether it clanks - and tick the one you are wearing. You can have one suit on plus one shield, and ticking a second suit takes the first one off. Picking a type fills in what that kind of armour usually does, and every field stays yours to change for the pieces that break the rules.',
      },
      {
        kind: 'change',
        text: 'Armor Class is worked out for you now, from the armour you have equipped: its AC, plus your Dexterity up to whatever the armour allows, plus a shield. Hover the number to see where it came from. Your current AC is untouched, so it stays exactly what it was until you equip something.',
      },
      {
        kind: 'new',
        text: 'AC modifiers, on the line under Armor Class. It works the way the global modifiers on your attacks do: tick the box and you get a list of the other things holding you together - a ring of protection, a cloak, a shield of faith, half cover - each with a name, what it adds, and its own tick so you can drop one the moment the spell ends without losing the line. Whatever is running is named on the sheet and added to your AC. Anything you had typed as your Armor Class before is waiting in there as a line called Other.',
      },
      {
        kind: 'new',
        text: 'Armour that clanks knows it. Tick Stealth disadvantage on the armour you are wearing and every Stealth check rolled from that sheet opens on Disadvantage, with a red "(Equipped armor)" beside it saying why. It is only a starting point: pick Normal or Advantage instead and it rolls that way, because whether you were really hampered is the table\'s call.',
      },
      {
        kind: 'change',
        text: 'The Equipment section is now called Inventory, and your coins have moved out of it into a Currency section of their own. Nothing you had written down has changed.',
      },
    ],
  },
  {
    date: '2026-08-13',
    entries: [
      {
        kind: 'new',
        text: 'Disadvantage, wherever advantage was already offered. The roll box now asks how you are throwing it: Normal, Advantage or Disadvantage. The chat shows both dice with the discarded one struck through, the same way it always has for advantage.',
      },
      {
        kind: 'new',
        text: 'Attacks can key off an attribute. Setting the To hit or Damage dice now offers an Attribute row between the die and the modifier: pick Dexterity and that attack carries your Dexterity modifier, so it reads 1d20+4+3 rather than a number you worked out yourself and typed in. It follows the score, so levelling up or a belt of giant strength changes every attack that asked for it with nothing to go and edit. None is the default and is what every attack you already have says.',
      },
      {
        kind: 'new',
        text: 'Global modifiers, in Attacks & spellcasting on a character sheet. Tick the box and you get a list of the situational things helping you: Bless adding 1d4 to hit, Rage adding 2 to damage, a magic weapon adding 1 to both. Give each one a name, say where it lands and what it adds, and it rides along on every attack you roll from that sheet until you untick it. The extra dice are rolled with the attack and land in the same total and the same line in the chat, which says where each number came from. When you roll, the confirm box lists what is riding along and lets you drop one just for that swing.',
      },
      {
        kind: 'new',
        text: 'Tokens have a Status. Pick one from the list in the token form, under Hit points, and hover the token on the map to read it under the hit point bar. The list is the 5e conditions - blinded, charmed, poisoned, prone and the rest - plus Custom at the end, which lets you type whatever the list does not cover. Everybody sees it, not just the DM: a player who cannot see that the ogre is prone is missing the thing that decides their turn. A token you have not set one on reads as Normal.',
      },
      {
        kind: 'fix',
        text: 'The top row and the left column of the grid can be used. On a map whose grid had been nudged, the row along the top edge was drawn like any other but no token could be put in it, by dragging or otherwise: the squares of the board started one row further down than the squares you could see. Every square that is drawn is now one you can use, and the far edges no longer offer a row that has slid off the map.',
      },
      {
        kind: 'fix',
        text: 'Placing a token now puts it in the square you right-clicked. Every placement was landing half a square up and to the left of where you asked for it, which made the top row and the left column nearly impossible to use: a click anywhere in the lower half of the first row put the token in the second one. Dragging a token was never affected.',
      },
      {
        kind: 'new',
        text: 'Show on map, a tickbox under the Name in the token form and another under Status. Tick either and the token wears that on the map all the time instead of only when somebody hovers it, which is what you want for the four guards who all look alike. Tick both and it reads Grunt [Poisoned]; tick only the status and it reads [Poisoned] on its own, so a monster whose name would give the game away can still show what it is suffering from. The plate sits above the token and moves below it when there is another token in the way or when the token is against the top edge. Both are off unless you ask for them, so nothing on your maps has changed.',
      },
      {
        kind: 'new',
        text: 'Use clipboard, beside every Upload button: one for the scene image and one for a token picture. Copy a picture anywhere - a crop out of a PDF, a screenshot, an image on a web page - and put it straight in without saving it to disk first. If what you copied is not a picture it says so and nothing else happens.',
      },
      {
        kind: 'new',
        text: 'Count as movement, in the measuring box. Tick it and the ruler prices a route the way the table does: take two diagonals in a row and the second one costs 10 ft, and any straight step in between clears that, so a zig-zag stays at 5 ft a square. Turning a corner does not clear it, and the ruler walks each leg the cheapest way round, which is what you would do yourself. Leave it off for ranges and spell radii, where every diagonal counts the same.',
      },
      {
        kind: 'change',
        text: 'Measurements are drawn as arrows now, so a route reads in the direction you walked it, and the measuring box lets you choose the colour and thickness. It starts in your own player colour, which is what tells the table whose ruler is whose when you share one; pick another and that is what everybody sees.',
      },
    ],
  },
  {
    date: '2026-08-12',
    entries: [
      {
        kind: 'fix',
        text: 'The Players and Users lists line up properly. Each column now sits in the same place on every row, so the Online and Offline labels, the dates and the role badges all read down the page instead of stepping about; in the Users list the column headings sit over their own columns too.',
      },
      {
        kind: 'new',
        text: 'Grid settings, behind a button in the scene bar for the DM. The grid now has a colour, a thickness and an opacity as well as a cell size, and everything you change is previewed on your own map alone until you press Save changes; Cancel puts it all back. The scene bar keeps just the Show grid checkbox.',
      },
      {
        kind: 'new',
        text: 'Adaptive contrast for the grid, in Grid settings. Each line takes the exact opposite of what is under it, pixel by pixel: black over white, white over black, cyan over red. Handy on a map that is pale in one corner and dark in the other.',
      },
      {
        kind: 'change',
        text: 'The grid is sized and slid from inside Grid settings now: while that window is open the wheel resizes the cells and right-dragging the map moves the grid over it. Close it and the wheel goes back to zooming.',
      },
      {
        kind: 'new',
        text: 'Characters and tokens can be coupled, from either the Characters tab or the Tokens tab. Linked, the two share hit points in both directions - damage on the map lands on the sheet, healing on the sheet shows on the map - and the token takes its initiative modifier from the character. Its name, picture and size stay its own. One character per token and one token per character; you can couple your own, and the DM can couple anything.',
      },
      {
        kind: 'new',
        text: 'Patch notes - this page. Every change worth knowing about, newest first.',
      },
      {
        kind: 'new',
        text: 'Character sheets belong to people now. Anyone at the table can make one and it is theirs immediately; the DM can hand any sheet to any player as view-only or fully editable, and take it back again - it disappears from their screen at once. Players see only the characters that are theirs, and the DM sees them all with a note of who holds each.',
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
        text: 'Floating windows - sheets, the turn tracker, the drawing box - have an opacity slider, so you can keep one over the map and still see the map.',
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
        text: 'Hovering a token tells you about it - name, hit points and initiative, showing each person only what they are entitled to see.',
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
        text: 'Everything moved into a database instead of loose files - faster, and it stops two people saving at once from losing one of the changes. Existing data is carried over automatically.',
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
 * different days depending on who is reading it - and this list is read
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
