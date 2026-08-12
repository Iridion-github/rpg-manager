# RPG Manager

A small, self-hosted Roll20-like virtual tabletop for playing RPGs online with a
few friends. Data lives in a **SQLite** file in a gitignored `/data` folder —
no server to install, no service to run, just a file you can copy. You run the
app on your own PC and expose it with a tunnel, so your machine *is* the server:
when you're offline, nobody can write.

## Stack
- **Backend:** Node + Express + Socket.IO (`server/`)
- **Frontend:** Vite + React (`client/`)
- **Storage:** SQLite via `better-sqlite3`, one file in `/data` (gitignored)

## Getting started
```bash
npm install                # root tooling (concurrently)
npm run install:all        # installs server + client deps
npm run dev                # runs server (:3001) and client (:5173) together
```
Then open http://localhost:5173. Both halves hot-reload: the client via Vite
HMR, the server via `node --watch` (a full restart — sockets reconnect on their
own).

## Running it for real
`npm run dev` is for development only; it needs Vite running to serve the UI.
For actual play, build the client once and let the server host everything from a
single port:

```bash
npm run serve               # = npm run build && npm start
```

Now http://localhost:3001 serves **both** the app and the API, which is the one
port you point a tunnel at. Rebuild (`npm run build`) after changing client code.

Started without a build, the server runs as an API only and says so — it won't
404 mysteriously.

**`npm start` requires `ADMIN_PASSWORD` and refuses to boot without it.** Without a
password every visitor is the admin, and the whole point of `npm start` is that
something outside your machine is about to reach it. `npm run dev` keeps the
open door for local work by passing `--open-gate` explicitly.

The server also binds to **localhost only** unless you set `HOST`. The tunnel
runs on this machine and dials localhost, so it loses nothing — and it means the
tunnel is the only way in, rather than the table being on whatever wifi you
happen to join. `HOST=0.0.0.0` to reach it from your phone on the same network.

## Campaigns
Everything — characters, maps, notes, chat — lives inside a **campaign**. Switch
campaign and the whole app changes with it; nothing is shared between tables
except the list of people who exist on the server.

Anyone signed in can start a campaign and is its **DM** from that moment. That's
what makes the interesting case work: you can run your own table and be an
ordinary player at your friend's, at the same time, with one identity.

A campaign is a *directory* on disk (`data/campaigns/<id>/…`), not a column in a
shared file. So one table's data can't leak into another through a forgotten
filter — the file simply doesn't contain the other campaign's records. Deleting
a campaign deletes its directory.

### The campaign directory
The list of campaigns is the front door — it's what you land on, before you're
at any table. It shows **every** campaign on the server, not just yours:

| Column | |
| --- | --- |
| **Campaign** | title and subtitle |
| **Players** | *how many* people are at that table |
| **Created** | when it started |
| **Last activity** | the last time a **DM** opened it |

The ones you're part of sort to the top and carry an accent stripe and your role
badge; the rest are muted, and their names aren't clickable — you can see the
shape of someone else's table, not walk into it.

Two deliberate limits:

- **Counts, never names.** "Four people play this" is a fact about the campaign;
  "these four people play this" is a fact about *them*. The members map never
  leaves the server through the directory — only its size. A campaign's own
  member list is readable by its members alone.
- **Seeing is not entering.** Sheets, scenes, chat and notes stay member-only
  and answer 404 to everyone else, enforced before those routes run. The
  directory is a directory, not a door.

**Last activity** means a DM was there, because a table is *being run* when the
person running it shows up — a player wandering in doesn't make a dormant
campaign live again. It's stamped when a DM opens the campaign and throttled to
once a minute, so refreshing your browser isn't a disk write. A campaign no DM
has opened yet reads `never`.

### Inside a campaign, or outside it
The app is in one of two modes, and the tab bar shows only the one you're in:

| | Tabs |
| --- | --- |
| **Outside** a campaign | Campaigns, Users, My account |
| **Inside** one | Tabletop, Characters, Notes, Music *(DM)*, Tokens, Players, Close campaign |

The inside tabs and the chat are views onto a *single* campaign's data, so
without one there is nothing for them to be views of — the tabs aren't greyed
out, they're absent, and the chat column doesn't reserve its space either. The
outside ones are the mirror image: they belong to the shell rather than to any
table, so while you're at one the way back is **Close campaign**, not a tab
sitting alongside its own contents.

Music is the DM's alone — for everyone else the soundtrack is scenery, and a
playlist they could read would name what they're only meant to hear.

Because of that the app always starts **outside** any campaign. It deliberately
doesn't reopen the one you had last: that would drop you inside a table on
arrival, and the directory you're meant to land on is reached by a tab that only
exists while you're outside one.

If a campaign closes under you — you're removed from it, or your account is
deleted — whatever you were looking at falls back to the directory rather than
emptying out where it stands.

## Roles

Roles come in two layers, and keeping them apart is the point.

**Globally**, who you are:

| Global role | How you get it | What it means |
| --- | --- | --- |
| **Admin** | log in as `admin` with `ADMIN_PASSWORD` | Acts as DM at every table, and can remove people |
| **User** | register | Can browse the directory and start campaigns |
| **Spectator** | nothing | No identity — you get the sign-in screen |

### Accounts
Register with a username and password, log in, log out. Passwords are hashed
with **scrypt** — a real key-derivation function from Node's standard library,
deliberately slow and memory-hard, so a stolen `users.json` can't be run through
a wordlist at speed. No plaintext is ever stored, and password hashes never
appear in any API response.

Logging in mints a **session token**, held in localStorage and sent as
`x-session`. Logging out destroys it *server-side*, so a copy that leaked
somewhere stops working rather than merely being forgotten by that browser.
Sessions last 30 days, and deleting an account kills its sessions immediately.

The **admin signs in through the same form**, as `admin` (or `ADMIN_USERNAME`)
with `ADMIN_PASSWORD`. That password stays server configuration rather than
being copied into the user file at first login — two places to change it, one of
them silently winning, is how you end up locked out.

**Invite links are gone.** A key in a URL signed you in by being opened, which
meant a credential that never expired, sitting in bookmarks, browser history and
whatever chat it was pasted into. Registration with a signup code does the same
job without any of that, so the whole path — the `?key=` link, the `x-user-key`
header, key rotation — has been removed, and any key still stored on an account
is swept away the next time the server starts. Old links now land on the sign-in
screen.

**Registration is open unless you set `SIGNUP_CODE`.** Open is the right default
on your own machine and the wrong one on a hostname a stranger can find, so the
startup banner says which you're running. With a code set, the sign-in screen
asks for it — and asks for nothing else: knowing the code is already proof of an
invitation, so an email address becomes optional. An open server has been told
nothing about who is registering, and still asks for one.

### My account, and the two ways to change a credential
Signed in, the **My account** tab shows what the server holds about you. Your
shown name changes on the spot. A password or an email address needs more,
because both are how you get back in:

| | always needed | then one of |
|---|---|---|
| Password | the current password | the signup code, **or** a link sent to your address |
| Email | — | the signup code, **or** a link sent to the address you're *leaving* |

Until the link is opened, nothing has changed — so somebody who finds an
unlocked browser can start either of these, and the person who owns the mailbox
simply never finishes it. The warning for an address change deliberately goes to
the old address: the person losing it is the one who gets to agree.

An account with no address on file has only the code. That's the same bargain it
made when it registered without one.

A new password is typed twice, because a password field shows you nothing and a
typo in a change you confirm by email is a lockout that only becomes apparent
later, at the sign-in screen, with no way back to the password you meant. The
two are compared untrimmed: a space at either end is a character like any other,
and quietly removing it would set a password you could never type again.

### Sending mail
Nothing is sent unless you configure SMTP, and you don't need an account with
anyone — any mailbox you already have will do, usually with an app password:

| variable | meaning |
|---|---|
| `SMTP_PASS` | the mailbox password — an *app password* at Gmail. **The only one that must stay out of the repo** |
| `SITE_EMAIL` | the address to send from and log in as. Has a default in `server/mailer.js`, since an address isn't a secret — set this only to run from a different mailbox |
| `SMTP_HOST` | the submission server; inferred for `@gmail.com`, required otherwise |
| `SMTP_PORT` | `587` (default) or `465` |
| `SMTP_SECURE` | override the guess (`465` is TLS from the first byte) |
| `SMTP_USER` / `MAIL_FROM` | only when the login and the sender aren't `SITE_EMAIL` — a relay sending on behalf of an address it doesn't own |
| `PUBLIC_URL` | what the links point at, e.g. `https://table.example.com` |

For an ordinary mailbox that's **one variable**: `SMTP_PASS`. The address lives
in `server/mailer.js` because it isn't a secret — it goes out on the front of
every letter — and the password never joins it there. Keeping the two apart
means there's no config file sitting next to the address inviting a credential
to be pasted in beside it.

**Gmail specifically**: the account's own password will not work — Google
requires an *app password*, which only becomes available once 2-Step
Verification is on. Create one at `myaccount.google.com/apppasswords` and use
those 16 characters as `SMTP_PASS`.

Half-configured says which half: a mailbox with a login and no password counts
as **not** configured rather than being attempted, because trying anyway turns
every password change into an authentication failure — worse than the outbox it
would otherwise have fallen back to. The startup banner names what's missing.

Leave `PUBLIC_URL` unset and links are built from the address the request
arrived on, which behind a quick tunnel is the tunnel's own hostname — so they
work without being reconfigured every time it restarts. Set it when the hostname
is stable.

**With no SMTP configured the flow still works**: the letter is written to
`data/outbox.log` and the server log instead of being sent, the screen says so
rather than claiming an email is on its way, and whoever runs the server can
fetch the link from there. The startup banner says which of the two you're in.

### Testing the roles
This is what accounts buy you beyond tidiness: log out, log in as somebody else,
and you *are* them. Register two accounts, have one start a campaign and add the
other as a player, and every permission boundary in the app is reachable from
one browser.

Under `npm run dev` an unauthenticated visitor is still treated as the admin —
but an explicit login always wins, including there. Without that rule, logging
in as a player on a dev server would silently keep making you the admin, which
would defeat the point.

**Per campaign**, what you are *at that table*:

| Table role | How you get it | What you can do |
| --- | --- | --- |
| **DM** | start a campaign, or be made one | everything in that campaign |
| **Player** | a DM adds you | move your own tokens, use the sheets you were given |

**Admin is DM at every table**, without being a member of any. It's an
administrative account — the person who runs the server, not somebody's
character — so it can open a campaign it was never invited to and do anything
the real DM could: read the sheets, move the tokens, delete the scene.

This is a deliberate reversal of how it started. Refusing it read as principled,
but the only person able to fix a broken table had to be invited to it first, by
the DM whose table was broken. The confidentiality it appeared to protect was
never real either: `/api/admin/backup` already hands whoever knows
`ADMIN_PASSWORD` the entire database, private notes included. Admin could always
read everything; all that changed is whether it has to be done through a file.

Two things follow, and both are intentional. **`ADMIN_PASSWORD` is now the only
secret that matters** — treat it accordingly, and don't reuse it. And
**membership still means what it says**: nothing writes the admin into a members
map, so a campaign's member list remains the truth about who *plays* there, even
though the admin can act at it. Don't add the admin account to a campaign as a
player; it would be ignored, since admin outranks membership rather than falling
back to it.

Any way of starting the server other than `npm run dev` demands `ADMIN_PASSWORD`
and won't boot without one:

```powershell
$env:ADMIN_PASSWORD='your-secret'; npm start     # PowerShell
```
```bash
ADMIN_PASSWORD=your-secret npm start             # bash
```

### Inviting people
Two separate steps, because they answer two different questions.

**Getting someone onto the server** is theirs to do: send them the URL and your
`SIGNUP_CODE`, and they register with a username and password of their own. The
code is what stops an open registration endpoint on a tunnel-exposed machine
being an invitation to anyone who finds the URL.

The **Users** tab lists who has registered, with a green dot for the people
connected right now and a red one for everybody else, and a **Last online**
column reading "5 minutes ago" or "last week" for the ones who aren't. Presence
is read from the live sockets on every request and stored nowhere — a saved copy
would survive a crash as a list of people the server *believes* are connected —
while `lastSeenAt` is written when a connection opens and again when it closes,
which is a different question from `lastLoginAt` and parts company with it the
moment somebody leaves a tab open for a fortnight.

Everyone signed in can read the list — it's the same one a DM reads when picking
members, and it carries names and colours and nothing else; the server strips
email, password hash and the rest before it leaves. Only the admin sees a way to
remove anybody, and the routes behind it refuse everyone else regardless of what
the page draws. It doesn't mint accounts and doesn't hand out credentials.

**Getting them to your table** is the DM's job: **Campaigns → Members**, and
pick Player or DM for each person. Being on the server gets you nothing on its
own; every table decides its own guest list.

A campaign always needs at least one DM, so you can't demote the last one —
there'd be nobody who could ever administer it again, and no higher authority to
appeal to.

## Tabletop
The **Tabletop** tab holds scenes: a map image, a grid, and tokens. The DM picks
maps; dragging is live — everyone sees a token move as it moves. Almost
everything done to a scene's tokens happens through the map's own right-click
menu.

A token carries an `ownerId`, and a player may drag a token that belongs to
them. The token form's **Belongs to** picker is what hands one over: choose a
member of this table, or "Nobody", which is what scenery and monsters are. Only
the DM sees that field, because handing a token to somebody is theirs alone.

What an owner may then do to their own token is a short list, and it is the
whole of what a player can do to the board:

| | Owner | DM |
| --- | --- | --- |
| Drag it about | ✅ | any token |
| Set its initiative | ✅ | any token |
| Take it off the table | ✅ | any token |
| Place it from the cast list | ✅ | any token |
| Rename, recolour, resize | their own, from the Tokens tab | any token |
| Assign it to somebody | — | ✅ |
| Delete it for good | their own, from the Tokens tab | ✅ |

Ownership is readable on the map without asking anyone. A token that belongs to
somebody carries a small pip in **their** colour — the same colour that names
them in the chat and marks them in the roster — and **your own** tokens also
carry a pale ring inside the edge. Those answer two different questions: whose
is that, and which of these is mine. The hover tooltip names the owner outright.

The pip is deliberately not the token's border: `borderColor` is the DM's to
choose per token, and ownership must not quietly overrule a decision somebody
made about how a token looks.

### Maps
Two ways to give a scene a background:

- **Built-in** — drop image files into `public/maps/`. They appear in the DM's
  *Built-in map…* dropdown. Served straight off disk, so adding one is a file
  copy: no rebuild, no restart.
- **Upload** — the *Upload map* button, for one-offs. Stored in `data/uploads`.

Either way the scene adopts the image's real pixel dimensions.

### One token per cell
Two tokens can't share a square. Tokens may be larger than one cell (a size-2
ogre covers 2×2), so the rule is really "footprints must not overlap". While you
drag over an occupied square the token outlines in red; release there and the
move simply doesn't happen — the token returns where it came from, with no error
message. Adding a token slides it to the first free cell rather than failing.

The check runs while the write lock is held, so two players releasing on the
same square at the same instant produce exactly one winner.

### Moving your view
**Right-drag to pan** — grab the map and push it around instead of reaching for
the scrollbars. A press that travels more than a few pixels is a pan; one that
doesn't is a click, and opens a menu instead. The threshold is why that works:
no hand is perfectly still for the length of a click, so testing for *no*
movement would mean the menu almost never opened.

**Scroll to adjust** — the wheel drives one of the bars in the scene bar rather
than the scrollbars: whichever of **Zoom** or **Grid** is selected there. Zoom
moves in 10% steps around the point under your cursor, so the map doesn't lurch
away from what you're looking at. Trackpad deltas accumulate, so a light
two-finger flick doesn't tear through the whole range.

Which gauge is selected also decides what a right-drag does, because both want
the same gesture:

| Gauge | Right-drag |
| --- | --- |
| **Zoom** | moves your view |
| **Grid** (DM) | moves the grid over the map — see below |

Left-drag moves a token you own — unless Draw mode is on, where the map becomes
a drawing surface instead.

The map runs to the bottom of the window, finishing level with the chat column
beside it, rather than stopping at a fixed fraction of the screen.

### Right-click menus
Right-clicking the **map** offers:

- **Ping** — coloured rings pulse at that spot on everyone's screen for a couple
  of seconds, in your own colour. Any member may ping.
- **Focus** — everyone at the table who is looking at this scene has their zoom
  set to match yours and their view centred on the spot you clicked. At a border
  or a corner it scrolls as far as there is map to scroll and no further, so the
  spot ends up off-centre rather than the map being padded with nothing. Anyone
  reading a *different* scene is left alone: moving their view to somewhere they
  can't see would be motion with no meaning.
- **Place Token** — put a token you already have onto this spot. The DM is
  offered every token in the campaign that isn't standing somewhere; everyone
  else is offered their own. Only shown when there is something to place, since
  an empty list behind a menu item is a promise the menu can't keep.
- **Create token** (DM only) — a form for name, colour and size. It never asks
  for a position, because the right-click already answered that; the token
  appears where you clicked, sliding to the first free cell if that one is
  taken.
- **Undo** and **Redo** — below a rule, because they act on what you have
  already done to the map rather than on the map itself. Greyed out rather than
  hidden when there's nothing left to take back, so where they *are* stays worth
  knowing. **Ctrl+Z** and **Ctrl+Shift+Z** do the same. See below.

Right-clicking a **token** offers:

- **Edit** (DM only) — the same form, prefilled.
- **Set initiative** — what this creature rolled, as a total or as a die plus a
  modifier. Open to the token's owner, because what you rolled is yours to say.
  It's a route of its own rather than a hole in the DM's edit: a form that can
  only reach three numbers can't grow a fourth by accident, and a player using
  it cannot rename their token through it.
- **Remove from table** — takes the token off this map and keeps it. Open to the
  owner. See below.
- **Delete** (DM only) — gone for good, at once, with no confirmation.

The last two look alike and only one can be undone, which is why the reversible
one is listed above the permanent one and named for what it does.

A player gets this menu on **their own** tokens only; on anybody else's they
keep the browser's own. Offering somebody a button that comes back 403 is worse
than not offering it.

### Off the table, but not gone
**Remove from table** doesn't delete anything. The token moves to the campaign's
own list of tokens and waits there — with its name, its picture, its owner, and
the hit points and initiative it earned in play. A character parked between
sessions comes back wounded, and comes back wherever you like: the same map or a
different one.

A token is therefore in exactly one place at any moment — standing on a scene,
or waiting off one — and keeps its id across the move, which is what lets it
keep its sheet link and its identity. It survives the deletion of the scene it
came from, because the list belongs to the campaign rather than to any map.

Positions in both signals travel as **map pixels**, not screen coordinates and
not cells — screen coordinates would send people with different window sizes to
different places, and cells stop being a unit at all when the grid is off.

Neither ping nor focus is ever stored. They live on the socket and nowhere else:
a minute later there is nothing that could have been saved.

### Grid ratio
A scene stores the map's **pixel size** and a `gridSize` — how many of those
pixels one cell covers. The DM's **Grid** slider changes only that ratio, so the
map never resizes; slide right for bigger (fewer) cells, left for smaller (more).
Column and row counts are derived from `width / gridSize`, never stored, so the
two can't drift out of agreement.

Note that tokens are positioned *by cell*, so re-tuning the grid moves them
relative to the art — settle the grid before placing tokens.

**Moving the grid.** Sizing the cells is only half of matching a map that came
with squares drawn on it; the other half is where those squares *start*. With
the **Grid** gauge selected, right-drag on the map slides the grid over the
picture, which stays exactly where it is. Get the size right by scrolling, then
push the grid onto the drawn one.

The offset is stored on the scene as `gridOffsetX`/`gridOffsetY` in map pixels,
held to one cell in each direction — a grid repeats, so a whole cell of travel
reaches every alignment there is. Tokens and shapes ride the grid rather than
the artwork, so a token in a cell stays in that cell as it moves.

While a drawing tool is in hand the Grid gauge is disabled: its gesture is a
right-drag, and that's how you move your view while drawing. One of the two has
to give, and it can't be the one that reaches the part of the map you're on.

### Drawing shapes
**Tools → Draw mode** opens a floating window and turns the map into a drawing
surface. The mode is the window being open, not a tool being held: from the
moment it opens you can pick up what's already drawn, and every shape shows its
centre mark. Choosing one of **Rectangle**, **Circle**, **Cone** or **Line**
adds the one thing that doesn't do on its own — pulling a *new* shape out of the
map. Right-drag still moves your view throughout.

The four are the set every tabletop with a template layer settles on. Each is
dragged out and then tuned by slider: a rectangle by two corners, a circle from
its centre, a cone and a line from the point they come out of. Cones default to
**53°**, the angle a 5e cone template cuts.

Everything shares fill and line colour, opacity, outline width, an optional
label, and snap-to-grid — which snaps to the nearest **half** cell, so a circle
centred on a corner and one centred in a square both work without a second
toggle.

Once drawn, a shape has three grips, told apart by where you take hold:

| Where | What it does |
| --- | --- |
| its middle | moves it |
| its outline | resizes it — a rectangle by the sides you grabbed |
| the mark at its centre | turns it, snapping to 15° |

The centre mark is a dot with a half-turn arrow around it, inked black or white
by whichever contrasts further with the fill. A circle gets the dot but no arrow:
it looks the same whichever way it faces, so there is no rotation to offer.
**Delete** rubs out the selected shape, and with nothing selected the panel
offers to clear the board.

Shapes are measured in **cells**, like tokens, so they keep their meaning when
the grid is retuned. Anyone playing may draw; what you drew stays yours to
change, and the DM may change anyone's — the same ownership rule tokens have.

### Undo and redo
The map's right-click menu carries **Undo** and **Redo**, and **Ctrl+Z** /
**Ctrl+Shift+Z** do the same while the tabletop is on screen. (A browser can't
tell the left Shift from the right one on a keypress, so either hand redoes.)
Both are ignored while you're typing in a text box, which keeps its own undo.

It reaches token moves, creations, edits and deletions; scene changes — cell
size, grid on/off, grid position, map image, name; and everything on the drawing
layer, with a cleared board coming back in one step.

Two rules make it safe at a shared table. The stack lives **in your browser
tab**, so it only ever holds your own actions — there is no way to reach
somebody else's from it, because it was never put there. And before reversing
anything, the entry re-reads the board and checks the thing is still as it left
it; if somebody else has moved that token or retuned that grid since, it refuses
and says so rather than undoing *their* work on top of yours.

Nothing is persisted: a reload starts with an empty history, because an entry is
a promise that something can be put back and across a reload that's a promise it
can't keep.

Movement is deliberately split in two: while you drag, positions go over the
WebSocket only and never touch the disk; on drop, one request persists the final
square. A drag would otherwise mean dozens of file writes a second.

## Tokens
The **Tokens** tab holds two things that share a word, one above the other.

### The artwork library
Every picture that can go on a token, read straight off `public/tokens/` —
nearly two thousand of them in nested folders. Browse by folder or search across
the lot by name. Everyone at the table can read it: knowing what art exists is
not the DM's secret, and a player who has seen it can ask for the right goblin
by name rather than describing it.

Adding art is a file copy. The listing is cached for a minute, so new pictures
appear without a restart, and thumbnails load only as they come into view.

The first look at it fetches a list of every file, which is the one genuinely
large answer in this app — so it says so while it loads, and doesn't block
anything else while it does. The list is then remembered for the rest of the
visit.

### This campaign's tokens
Below the library: the actual pieces this table plays with, made in advance of
needing them. Each belongs to somebody, and each is either standing on a map or
waiting to be placed on one — the row says which, naming the scene.

| | Player | DM |
| --- | --- | --- |
| Sees | their own tokens | every token in the campaign |
| Creates | **one** — after that the button is gone | as many as they like |
| Edits, deletes | their own | anybody's |
| Assigns an owner | — | any token |

The one-token limit counts who **created** a token, not who owns one. A DM
handing you a second character shouldn't cost you the right to have made your
own, and being given three tokens shouldn't mean you were never allowed one — so
a token remembers both `createdBy` and `ownerId`, and they answer different
questions.

**No hit points and no initiative here.** Those are decided in the moment, on
the tabletop, by whoever is looking at the fight — this form is about what a
token *is*, not what it is doing. Values earned in play ride along untouched by
anything on this screen.

Editing works wherever the token is. Rename one that's standing on a map and it
keeps its square, its wounds and its place in the turn order; the map shows the
new name at once.

## Character sheets

### Who can see which sheet
The DM decides, per sheet, what each player gets: **no access**, **can view**, or
**can edit**. Open a character and hit *Who can see this*. The DM always sees and
edits everything, and is the only one who can change these settings.

A sheet nobody has been given is **DM only**, which is what a new character
starts as — handing it out is a decision, and defaulting to "everyone" is the
wrong way to be wrong. Spectators, having no identity, see no sheets at all.

Access is one map of `playerId → view | edit` rather than separate viewer and
editor lists, because those two can disagree — an editor missing from the
viewers — and then there are two answers about who can read the sheet.

**The rule is enforced on the way out, not just on the way in.** A player is
never *sent* a sheet they can't see: not in the list, not by id, and not over
the WebSocket, where each connection is sent only what that connection may know.
Revoking access takes effect live — the player's copy is dropped from their
screen rather than lingering until they reload.

Changing who may edit a sheet is a **separate endpoint** from editing the sheet,
so the two can never be the same request. A player editing their own character
sends the whole sheet back; if access travelled in that body, they could promote
themselves while doing it. Creating and deleting characters stays the DM's.

### The sheet
A full **D&D 5e** sheet, across three pages matching the printed one:

- **Character** — abilities, saving throws, all 18 skills, proficiency and
  expertise, AC / initiative / speed, HP, hit dice, death saves, attacks,
  equipment and coin, personality / ideals / bonds / flaws, features.
- **Details** — age, height, weight, eyes, skin, hair, appearance, backstory,
  allies & organizations, additional features, treasure.
- **Spellcasting** — spellcasting class and ability, save DC and attack bonus,
  slots per level, and the spell list from cantrips to 9th with prepared marks.

**Only raw values are stored.** Ability modifiers, proficiency bonus, save and
skill bonuses, passive Perception, initiative, spell save DC and spell attack
are all worked out on the fly. A stored modifier is one that can disagree with
the score it came from — then there are two answers and no way to tell which is
right.

### Rolling from the sheet
Ability names, saving throw names and skill names are **clickable**. Clicking
one asks whether to roll it — with an **Advantage** option (2d20, keep the
highest) — and on confirming, the result lands in the chat labelled with the
character and what was rolled, so a DM rolling for a whole table can tell them
apart. Cancelling does nothing at all: no request, no message.

Each attack has its own 🎲 button before the name, which rolls its to-hit and
damage together.

Skill proficiency cycles none → proficient → **expertise** (double proficiency),
which is what the two circles on the paper sheet mean. Sheets from before this
schema keep their old `hp`/`maxHp`/`ac`/`notes` values rather than resetting.

## Notes & handouts
The **Notes** tab is the DM's prep: a title and a body, as many as you like.
Each note has a **Share with players** checkbox, and that one flag is the whole
feature — an unshared note is private prep, and ticking the box turns the same
note into a handout the table can read under their own **Handouts** tab.

Sharing posts a line in the chat (*"shared a handout: …"*), because a handout
nobody notices may as well not exist. Only the moment of sharing announces
itself, so editing a note that's already out doesn't nag the table. Unticking
the box takes it back.

**The server decides what you can see, not the browser.** A player's request for
the note list returns only shared notes — the private ones are never sent, so
there's nothing in their browser to reveal with the dev tools. For the same
reason a live update carries only *which* note changed, never the note itself:
a broadcast reaches every connected client regardless of role.

Handouts are cached like character sheets, so players can still read them when
your PC is off. A player's cache only ever holds what the server sent them,
which is to say: nothing private.

Typing is saved on the same debounce as a character sheet; ticking the share box
saves at once, since waiting out a debounce to see a checkbox take effect feels
broken.

## Music
The **Music** tab is the campaign's playlist. The DM pastes a YouTube link and
saves it; pressing ▶ starts it for everyone at the table.

**No audio crosses the wire.** What's broadcast is an instruction — *this video,
started at this moment* — and each browser plays its own copy, seeking to
`now − startedAt`. That's what lets someone arriving late join a track already
in progress instead of restarting it for themselves.

The player lives beside the chat, not in the tab, because a component inside a
tab is unmounted the moment you switch away from it — and an unmounted player is
silence. Deleting whatever is currently playing stops it, rather than leaving
music nobody can name.

**Only the DM sees any of this.** The Music tab is theirs alone, and so is the
player: everyone else hears the music and is told nothing about it — no video,
no title, no controls, no playlist. It's the table's scenery, not a jukebox they
can read. Their copy of the iframe is parked off-screen rather than removed,
because a frame the browser doesn't render can have its playback suspended, and
silence is the one outcome this must not produce.

Links are parsed server-side, so `youtu.be/…`, `/watch?v=…`, `/shorts/…`,
`music.youtube.com`, extra `&t=`/`&list=` params and a bare video id all work,
and anything that isn't a YouTube video is refused once rather than by each
client.

**Naming a track.** Give it a title when you save it and that's what it's
called — *Tavern, quiet* beats whatever the uploader called the video, and it
skips the lookup. Leave the field blank and the title comes from YouTube's
public oEmbed endpoint (no API key); if that request fails too, the track keeps
the video id as its name and still plays. Titles are editable in the list
afterwards — click one, type, and it saves when you leave the field. Renaming
whatever is currently playing updates the player without restarting the song.

**Copy link** puts the video's URL on your clipboard. That needs a secure
context, which the tunnel provides; on a plain-http LAN address the browser
refuses and the link is shown in a prompt to copy by hand instead.

### What to expect from it
Three things are worth knowing before you rely on this mid-session:

- **The first sound may need a click.** Browsers block audible playback the user
  didn't initiate. The DM is always fine — they clicked play. For everyone else
  the player retries on the next click or keypress *anywhere on the page*, so
  switching a tab or typing in the chat is usually enough and they never notice.
  Only if that hasn't happened does a single **Enable sound** button appear —
  the one thing a player ever sees, and it names nothing. It's the browser's
  consent gate, not a music control: without it, a blocked player would sit in
  silence with no way out.
- **Not every video can be embedded.** Plenty of official music videos are
  blocked from playing outside YouTube, or are region-locked. Those fail no
  matter what, and say so in the player rather than going quietly silent.
- **Sync is approximate.** Everyone lands within roughly a second, depending on
  their connection and how fast YouTube buffers. That's right for background
  music and wrong for anything that needs to be in unison.

## Chat
A 250px column on the right, visible on every tab. Everyone at the table can post. Enter sends, Shift+Enter starts a new line.

The author on a message comes from the credential that sent it, never from the
request — you can't post as someone else. The log keeps the most recent 300
messages and lives in one record, so appending and trimming are a single atomic
write. On narrow screens the column drops below the table instead of squeezing
it.

### Dice
The **Dice** button opens a roller: how many, which die (coin, d4, d6, d8, d10,
d12, d20, d100), and a modifier **added once to the total** — `2d20+5` rolling 5
and 15 is 25, not 30. A coin has no value to modify, so that field switches off
and it reports Heads/Tails.

Results post to the chat showing every die, not just the total, with natural 1s
and maximums highlighted. **The server rolls, not the browser** — a roll made in
the client is a roll the client can choose, and that's the one number at a table
nobody should control. It uses `crypto.randomInt`, which is uniform;
`Math.random() * n` is not.

## Going online
A **Cloudflare Tunnel** makes your PC reachable from the internet without port
forwarding, a static IP, or anything opened on your router. `cloudflared` dials
*out* to Cloudflare and traffic comes back down that connection, so your machine
never accepts an inbound connection at all.

Install it once:

```powershell
winget install --id Cloudflare.cloudflared     # Windows
brew install cloudflared                       # macOS
```

### Quick tunnel — no account, no config
```powershell
$env:ADMIN_PASSWORD='your-secret'; npm run online
```

That builds the client, starts the server, and opens a tunnel beside it. Look
for the `https://something-random.trycloudflare.com` URL in the output — that's
your table. Send it to your friends along with the signup code.

The catch: the URL is new every time you start it, so the address you sent
yesterday points nowhere today. Fine for a one-off session, annoying as a habit
— and worth knowing if you rely on emailed confirmation links, which is why
`PUBLIC_URL` is best left unset with a quick tunnel.

### Named tunnel — a hostname that survives a restart
Worth it if you own a domain on Cloudflare and want to send one link forever.
Copy `cloudflared/config.example.yml` to `cloudflared/config.yml` and follow the
steps in its comments — three `cloudflared` commands, one of which opens a
browser to pick your domain. Then:

```powershell
$env:ADMIN_PASSWORD='your-secret'; npm run serve      # one terminal
cloudflared tunnel --config cloudflared/config.yml run   # another
```

Your real config is gitignored: it names your hostname and points at a
credentials file.

### Before you send the link
- **`ADMIN_PASSWORD` is set** to something you didn't reuse elsewhere. The server
  won't start without it, so this is hard to get wrong.
- **`SIGNUP_CODE` is set**, and your friends have it. Anyone without it can't
  register, and lands as a spectator — which is the right outcome for a stranger
  who finds the URL.
- **The table is only up while the tunnel is.** Close it and the site is gone —
  that's the design, not a failure. Friends who've loaded it keep a read-only
  cached view.

### When it decides you're offline
The read-only cached view is what everyone falls back to when the server can't
be reached, so what counts as "can't be reached" matters. It is an HTTP request
actually failing — not the WebSocket dropping.

The two used to share a flag, and that was a real fault on a busy tunnel: a
connection carrying a few hundred token thumbnails starves the socket's
heartbeat long before it troubles a request, so a live socket timing out emptied
the whole app into its cache while everything was in fact working. A dropped
socket now means *live updates have stopped*, and prompts one small request to
find out about the rest. A server that really has gone still lands you in the
cached view a moment later — it just has to be true first.

Responses are gzipped on the way out, which matters most on that same link:
`cloudflared` forwards the browser's `Accept-Encoding`, so without it the hop
from this server to Cloudflare carries every byte uncompressed. Artwork is left
alone (a `.webp` comes out of gzip larger than it went in) and so is anything
under `/api/auth`, where a response carrying a session token beside a
caller-chosen username is the shape BREACH reads secrets from.

## Putting it online (Render)
The tunnel needs your PC switched on. To have the table reachable all the time,
`render.yaml` in this repo configures a Render service — create it with
Render's **Blueprint** option and it reads the file rather than asking you to
retype the settings.

Three things have to be true together, and each one fixes a failure that is
otherwise silent:

| | Why |
| --- | --- |
| **Starter instance**, not Free | Free instances sleep after ~15 min idle **and** have no disk |
| **A disk mounted at `/data`**, with `DATA_DIR=/data` | Without it every deploy and restart is a factory reset |
| **`HOST=0.0.0.0`** | The server binds to localhost by default; in a container nothing can reach it and the health check fails with nothing in the logs |

The free tier is the trap worth naming: it *looks* like it works. You'd deploy,
register, build a campaign, and come back the next day to an empty server with
no error anywhere. The instance type is what stops the sleeping; the disk is
what keeps the data. Buying one without the other solves nothing.

You set `ADMIN_PASSWORD` and `SIGNUP_CODE` in the dashboard — `render.yaml`
marks them `sync: false` so they're never read from the repo. Leave
`SIGNUP_CODE` unset and anyone who finds the URL can register.

Note that only **one instance** may run. SQLite is a file, and two processes
writing one file over a network disk corrupt it. Render enforces this itself
once a disk is attached, at the cost of a few seconds' downtime per deploy.

You don't need Postgres for this. SQLite on a mounted disk is entirely adequate
for one instance and a few friends.

### Guessing attacks
Login and registration count failed attempts and stop answering after ten, for
fifteen minutes and an hour respectively. Without that, a secret is only as
strong as it is long — a four-digit signup code is ten thousand requests, which
is minutes of scripting.

Only *failures* count and a success clears the counter, so an evening of
mistyping never adds up to a lockout. Login is keyed by address **and** by
account, because one address trying every account and every address trying one
account are both brute force.

The counters live in memory. A restart forgets them, which is the right trade
here: the alternative is a table of failed logins on disk, and the thing being
defended already sits behind a password.

**`TRUST_PROXY` matters for this.** Behind Render's router or a Cloudflare
Tunnel every request arrives from the same address, so without it the limiter
puts the whole table in one bucket and one person's typo locks out everybody.
`render.yaml` sets it to `1`; set it to `1` behind a tunnel too. It defaults to
off because the opposite mistake is worse — trusting a forwarding header nobody
set lets a caller claim any address it likes.

### Rate ceilings
Separately from the guessing counters above, every `/api` call is charged to a
bucket: your account when you're signed in, your address when you aren't. 600 a
minute, which is an order of magnitude above what a table in full flow produces
and low enough to stop a script. Uploads get their own, far tighter ceiling — 40
an hour — because they are the one write that costs disk you're paying for.

Per account rather than per address on purpose: four friends behind one router
are one address, and an address-only ceiling would have them spending each
other's quota.

### Browser-facing headers
Every response carries `Content-Security-Policy`, `X-Content-Type-Options:
nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a
`Permissions-Policy` turning off camera/mic/geolocation/payment, and — over TLS
only — HSTS. They're written out in `server/security.js` rather than pulled from
a package, because the YouTube player rules out any off-the-shelf policy and a
header you can read is one you can argue with.

The policy allows inline **styles** (every token on the map is positioned with a
style attribute) but not inline **scripts**, and reaches off-origin only for the
YouTube player. Session tokens live in `localStorage`, so the thing that would
hurt most is script injection — that's what the script half of this is for.

### Cross-origin access
`ALLOWED_ORIGINS` is an allowlist, and empty is the right answer for a published
server: the app is served from the same origin as its API, and same-origin
requests never consult CORS. It exists for the split dev setup, where the client
runs on 5173 and the API on 3001 — those are allowed automatically when the
write gate is off. `*` is not reachable, deliberately: with the gate open an
unauthenticated caller *is* the admin, so a wildcard would turn any page you
happened to visit into a remote control for your own machine.

### Uploads
The type is decided by reading the file's first bytes, not by believing the
`Content-Type` the browser sent. Anyone can label a script `image/png`; it would
then sit on this origin under a name we chose, and only the browser's good
manners would stand between that and script running in someone's session. PNG,
JPEG, WEBP and GIF signatures are checked, the extension comes from what the
bytes say, and the filename is generated. 20 MB a file, 40 an hour.

### Before you publish
- Set `ADMIN_PASSWORD` — long and unique. It's the master key: the admin can
  read every campaign and download the whole database.
- Set `SIGNUP_CODE` unless you actually want strangers registering.
- Set `TRUST_PROXY=1` behind Render or a tunnel, or the rate limits see one
  address for everybody.
- Leave `ALLOWED_ORIGINS` unset unless you're serving the UI from a different
  hostname than the API.
- `npm audit` in both `server/` and `client/` — clean as of the last check.

## Backups
A mounted disk survives restarts, not mistakes — a bad import or a campaign
deleted in the wrong tab is still gone. `GET /api/admin/backup` (admin only)
pulls the entire database down as one file, while the server keeps running.
There is no button for it in the app; call it with an admin session token, e.g.
`curl -H "x-session: <token>" -OJ localhost:3001/api/admin/backup`.

It goes through SQLite's online backup API rather than copying the file, and
that distinction matters: in WAL mode the committed state is spread across the
database *and* its write-ahead log, so a plain copy taken while the server runs
can miss recent transactions or be torn outright. The snapshot you get opens
cleanly and passes `integrity_check`.

Restoring is putting that file where `DATA_DIR` expects it, with the app
stopped.

## Data location
Everything lives in `./data` (override with `DATA_DIR`): one SQLite database,
plus uploaded map images as files. The folder is gitignored — back it up like
any important files. Stopping the server and copying `rpg-manager.db` is a
complete backup.

```
data/
  rpg-manager.db              everything: users, campaigns, sheets, scenes, chat…
  rpg-manager.db-wal/-shm     SQLite's write-ahead log; copy them too, or stop first
  uploads/                    uploaded map images (still ordinary files)
```

### How it's stored
One `records` table of `(collection, id, JSON)`. A character sheet is a
*document* — nested abilities, skills, a spell list — and nothing ever asks "all
characters with STR above 15", so shredding it across eighty columns would buy
joins and cost clarity. Where a constraint genuinely earns its keep, an
expression index provides one: username and email are **unique in the database**,
not merely checked in JavaScript before an insert that could still race.

The collection name carries the campaign — `campaigns/<uuid>/sheets` — and is the
leading half of the primary key. That's deliberate. The obvious translation
would be one `sheets` table with a `campaign_id` column, and then any query that
forgets its `WHERE` clause quietly serves another table's secrets. Here there is
no row you can reach without naming its campaign first, and deleting a campaign
is deleting a key prefix.

`store.mutate()` — read-modify-write — is now a real transaction. It used to be
a hand-rolled promise queue, which existed only because files have none.

### Upgrading from JSON
A `data` folder from any earlier version is imported automatically on first
start, including the pre-campaign flat layout: `players.json` becomes users, and
loose `sheets/scenes/chat/notes.json` are folded into a campaign called
**Imported Campaign** with the admin as DM and everyone else as players.

Ids and timestamps are carried across unchanged, so token ownership and
per-sheet access grants keep working — a campaign doesn't claim it was created
today because you changed database engines. The source files are
renamed `*.imported` rather than deleted, and if the import throws, the server
refuses to start rather than serve half-moved data.

It runs when the database holds **nobody's game yet** — either no records at
all, or nothing but the admin account seeded at first login and the sessions
handed out since. Those two don't count, and that distinction matters: the admin
record is written the moment you log in, so treating it as data meant a single
curious look at the app before the JSON landed stranded that folder for good,
with no error and no way back short of deleting the database. A second account
*does* count — once someone has registered, that's their table, and it isn't
worth trading for a folder.

That scaffolding is cleared as part of the import, so the JSON decides who
exists rather than colliding with a placeholder that shares its username. You
sign in again afterwards; the admin password is unchanged, since it's server
configuration rather than anything stored on the account.

## Environment variables
| Variable | Default | Purpose |
| --- | --- | --- |
| `ADMIN_PASSWORD` | *(unset)* | The admin's login password. **Required** except under `npm run dev` |
| `ADMIN_USERNAME` | `admin` | Username the admin logs in with |
| `SIGNUP_CODE` | *(unset — open)* | When set, registration demands this code — and makes an email address optional, and lets a password or address change skip the emailed confirmation |
| `GM_PASSWORD` | *(unset)* | Old name for `ADMIN_PASSWORD`, still honoured |
| `SMTP_PASS` | *(unset — mail off)* | The sending mailbox's password; an **app password** at Gmail. The one mail variable that must stay out of the repo |
| `SITE_EMAIL` | *(default in `server/mailer.js`)* | Address to send from and log in as. Not a secret — set it only to send from a different mailbox |
| `SMTP_HOST` | *(inferred for `@gmail.com`)* | Submission server. Required for any other provider |
| `SMTP_PORT` | `587` | `465` for implicit TLS |
| `SMTP_SECURE` | *(from the port)* | Override the guess that `465` means TLS from the first byte |
| `SMTP_USER` / `MAIL_FROM` | *(from `SITE_EMAIL`)* | Only where the login and the sender genuinely differ |
| `PUBLIC_URL` | *(the request's own host)* | What confirmation links point at. Leave unset behind a quick tunnel, whose hostname changes every restart |
| `ADMIN_NAME` | `Admin` | Display name given to the admin account **when it is first created**. Renaming it later is a normal edit (`PUT /api/users/:id`) and this variable won't override it |
| `DATA_DIR` | `./data` | Where the database + uploads live |
| `DB_FILE` | `$DATA_DIR/rpg-manager.db` | The SQLite file itself |
| `PORT` | `3001` | Server port |
| `HOST` | `127.0.0.1` | Interface to bind. Localhost by default; `0.0.0.0` for LAN |
| `TRUST_PROXY` | *(off)* | Proxies in front of the app. `1` behind Render or a tunnel |
| `ALLOWED_ORIGINS` | *(none in production, localhost in dev)* | Comma-separated origins allowed to call the API cross-origin. Unset is correct when the UI and API share a hostname |
| `VITE_API_TARGET` | `http://localhost:3001` | Backend the dev client proxies to |
| `CLIENT_DIST` | `client/dist` | Built UI to serve in production |

## Roadmap
1. ✅ Server + atomic file store + character-sheet CRUD + live refresh
2. ✅ IndexedDB offline read-only cache
3. ✅ Full WebSocket live-sync (optimistic updates, debounced saves)
4. ✅ Tabletop: map + grid + draggable tokens with per-player ownership
5. ✅ Dice roller, notes/handouts
6. ✅ Cloudflare Tunnel for internet access
7. ✅ Campaigns: per-campaign data and roles, global admin
8. ✅ Shared music: the DM's YouTube playlist, played for the whole table
9. ✅ Accounts: registration, login, logout, hashed passwords, sessions
10. ✅ SQLite instead of JSON files: real transactions, real constraints
11. ✅ Rate limits on login, registration and password changes
12. ✅ Right-click menus on the map: ping, focus, create/edit/delete tokens
13. ✅ Grid offset: slide the grid onto a map that came with one drawn on it
14. ✅ Per-tab undo/redo of your own map actions, refusing to reverse anyone else's
15. ✅ A drawing layer: rectangle, circle, cone and line, drawn and tuned on the map
16. ✅ My account: change your shown name, password and email — the last two
    confirmed by an emailed link, or by the signup code
17. ✅ Invite links removed: registration and sessions are the only way in
18. ✅ Assign a token to a player from the UI, so per-player ownership is reachable
19. ✅ A campaign's own tokens: made in advance, taken off the table without
    being destroyed, and placed again on any map
20. ⬜ Password recovery, so a forgotten password isn't a deleted account
21. ⬜ The test suites in the repo, behind `npm test`
22. ⬜ Restore a backup through the app, so `/api/admin/backup` round-trips

**[NEXT-STEPS.md](NEXT-STEPS.md)** takes the remaining ones in order and says what
each involves, what's already built underneath it, and how we'd know it was
finished.
