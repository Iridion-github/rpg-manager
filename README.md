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
The **Tabletop** tab holds scenes: a map image, a grid, and tokens. The GM
uploads maps, adds tokens, and assigns each one to a player. Dragging is live —
everyone sees a token move as it moves.

Movement is deliberately split in two: while you drag, positions go over the
WebSocket only and never touch the disk; on drop, one request persists the final
square. A drag would otherwise mean dozens of file writes a second.

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
