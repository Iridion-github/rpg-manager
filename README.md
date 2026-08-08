# RPG Manager

A small, self-hosted Roll20-like virtual tabletop for playing RPGs online with a
few friends. **No database** — all data lives as JSON files in a gitignored
`/data` folder. You run the server on your own PC and expose it with a tunnel, so
your machine *is* the server: when you're offline, nobody can write.

## Stack
- **Backend:** Node + Express + Socket.IO (`server/`)
- **Frontend:** Vite + React (`client/`)
- **Storage:** atomic JSON files in `/data` (gitignored)

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

## Roles

Three roles, decided by the server from whatever credential you present:

| Role | How you get it | What you can do |
| --- | --- | --- |
| **GM** | know `GM_PASSWORD` | everything |
| **Player** | open an invite link | move **your own** tokens |
| **Spectator** | nothing | read-only |

With no `GM_PASSWORD` set the gate is open and everyone is treated as the GM,
which keeps local development frictionless. Set one in real use:

```bash
GM_PASSWORD=your-secret npm run dev
```

Then click **I'm the GM** in the app and enter it.

### Inviting players
Open the **Players** tab (GM only), add a friend, and hit *Copy invite link*.
The link looks like `https://your-tunnel/?key=…`; their browser claims the key
and remembers it, so they land as themselves every time.

Players never self-register — you create them. An open registration endpoint on
a tunnel-exposed machine would let anyone who found the URL mint an identity.
If a link leaks, **Rotate key** invalidates it without disturbing that player's
tokens.

## Tabletop
The **Tabletop** tab holds scenes: a map image, a grid, and tokens. The GM picks
maps, adds tokens, and assigns each one to a player. Dragging is live — everyone
sees a token move as it moves.

### Maps
Two ways to give a scene a background:

- **Built-in** — drop image files into `public/maps/`. They appear in the GM's
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
the scrollbars. The context menu is suppressed over the map so the gesture stays
out of its way; right-clicking a *token* still opens the normal menu.

**Scroll to zoom** — the wheel drives the zoom bar instead of the scrollbars, in
the same 10% steps, and zooms around the point under your cursor so the map
doesn't lurch away from what you're looking at. Trackpad deltas accumulate, so a
light two-finger flick doesn't tear through the whole range.

Left-drag is unchanged: it moves a token you own.

### Grid ratio
A scene stores the map's **pixel size** and a `gridSize` — how many of those
pixels one cell covers. The GM's **Grid** slider changes only that ratio, so the
map never resizes; slide right for bigger (fewer) cells, left for smaller (more).
Column and row counts are derived from `width / gridSize`, never stored, so the
two can't drift out of agreement.

Use it to line the grid up with a map that already has squares drawn on it. Note
that tokens are positioned *by cell*, so re-tuning the grid moves them relative
to the art — set the grid before placing tokens.

Movement is deliberately split in two: while you drag, positions go over the
WebSocket only and never touch the disk; on drop, one request persists the final
square. A drag would otherwise mean dozens of file writes a second.

## Character sheets
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
character and what was rolled, so a GM rolling for a whole table can tell them
apart. Cancelling does nothing at all: no request, no message.

Each attack has its own 🎲 button before the name, which rolls its to-hit and
damage together.

Skill proficiency cycles none → proficient → **expertise** (double proficiency),
which is what the two circles on the paper sheet mean. Sheets from before this
schema keep their old `hp`/`maxHp`/`ac`/`notes` values rather than resetting.

## Chat
A 250px column on the right, visible on every tab. The GM and players can post;
spectators read only. Enter sends, Shift+Enter starts a new line.

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

## Data location
JSON files are written to `./data` by default (override with `DATA_DIR`), with
uploaded maps under `./data/uploads`. This folder is gitignored — it's your local
"database". Back it up like any important files.

## Environment variables
| Variable | Default | Purpose |
| --- | --- | --- |
| `GM_PASSWORD` | *(unset — open)* | Enables the write gate and makes you the GM |
| `DATA_DIR` | `./data` | Where JSON + uploads are written |
| `PORT` | `3001` | Server port |
| `VITE_API_TARGET` | `http://localhost:3001` | Backend the dev client proxies to |
| `CLIENT_DIST` | `client/dist` | Built UI to serve in production |

## Roadmap
1. ✅ Server + atomic file store + character-sheet CRUD + live refresh
2. ✅ IndexedDB offline read-only cache
3. ✅ Full WebSocket live-sync (optimistic updates, debounced saves)
4. ✅ Tabletop: map + grid + draggable tokens with per-player ownership
5. Dice roller, notes/handouts
6. Cloudflare Tunnel for internet access
