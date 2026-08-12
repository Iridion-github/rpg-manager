# Next steps

Four things worth doing next, in the order I'd do them. Each says what it is,
why it earns its place, what it actually involves, and how we'd know it was
finished.

The ordering rule: **finish what is already 90% built before starting anything
new**, and prefer the thing a player at the table would notice.

---

## 1. Assign a token to a player — ✅ done

Built. A **Belongs to** picker in the token form, the owner's colour as a pip on
the token, a white ring on your own, and the owner named in the hover tooltip.
No server change was needed: `sanitizeToken` already accepted and validated
`ownerId`, which was the whole point — the field every check read was the one
field nothing ever set.

The open question below was settled this way: **both**. A pip in the owner's
colour says *whose* to everybody, and a ring inside the token says *yours* to
you. They're different questions and a player asks the second one far more
often.

<details>
<summary>The original plan, kept for the record</summary>

**The state of it.** `ownerId` is already honoured in four places — the HTTP move
route, the socket drag authorisation, `canMove` on the client, and the red
outline that warns mid-drag. The server accepts and validates it on both create
and edit. And nothing in the app ever *sets* it: token creation hardcodes
`ownerId: null`.

**Why it's first.** Every token on every map is therefore a DM token, and your
players cannot move their own characters. For a virtual tabletop that isn't a
missing nicety, it's the thing that makes it a shared table rather than a screen
the DM drives. It is also the cheapest of these by a distance: the whole
permission system behind it exists and is tested, so this is a form and a
marking, not a feature.

**Steps**

1. **An owner picker in the token form** (`TokenModal.jsx`) — a select listing
   this campaign's members plus "Nobody (DM token)". The modal already receives
   what it needs to render one; the members come from the same list the DM's
   Players tab reads.
2. **Send it on create** (`Tabletop.jsx`, `submitToken`) — the `ownerId: null`
   currently hardcoded there becomes the form's answer. Editing already passes
   the form's fields through, so an owner can be changed after the fact by the
   same route.
3. **Show ownership on the map** — a token that belongs to someone needs to read
   as theirs at a glance. The token already carries a `borderColor`; the owner's
   own colour is the obvious candidate, and every user has one.
4. **Undo coverage** — assignment goes through `recordTokenEdit`, which already
   records arbitrary field changes, so this should fall out. Worth an explicit
   check rather than an assumption.
5. **Check the ownership rules end to end** — a player may move only their own,
   the DM may move any, and a token reassigned mid-session takes effect on the
   next drag rather than needing a reload.

**Open question to settle first.** Should a player see *their own* tokens marked
differently from other players' tokens, or is one "this belongs to somebody"
marking enough for everyone? That changes the visual design, so it's worth
answering before drawing anything.

**Done when** a DM can hand a token to a player, that player can drag it and
nobody else can, and the map shows whose is whose without anybody having to ask.

</details>

---

## 2. Password recovery

**The state of it.** The account system now collects an address, confirms a
change of one by emailed link, and lets the signup code stand in for that link.
The reason to have an address at all — getting back in — does not exist. Nor can
the admin help: they can rename and delete a person, and nothing else. The only
remedy for a forgotten password today is deleting the account and registering
again, which takes the person's campaign memberships with it.

**Prerequisite.** `SMTP_PASS` — the app password for `rpgmanageradmin@gmail.com`.
Until that's set, mail goes to `data/outbox.log` and none of this can be tested
for real.

**Steps**

1. **A "forgot your password" link** on the sign-in screen, asking for a username
   or address.
2. **The reset request**, deliberately answering the same way whether or not the
   account exists — otherwise the form becomes a way to discover who has an
   account here.
3. **A held reset**, reusing `accountChanges.js` as it stands: the token hashed
   in the database, single use, expiring in an hour, superseded by a newer
   request. That module was written for this shape of problem and needs a third
   `kind`, not a rewrite.
4. **The reset page** — the existing `ConfirmChange` screen, which already asks
   before acting rather than acting on the GET, plus a field for the new
   password typed twice.
5. **Rate limits** on the request endpoint, keyed both by address and by caller,
   like the login route.
6. **Decide the no-address case.** An account registered under a signup code may
   have no address, so it can have no reset. The honest answer is probably an
   admin-triggered reset link, which is a small addition to the Users tab.

**Done when** somebody who has forgotten their password can get back into their
own account without an admin deleting anything.

---

## 3. Bring the tests into the repo

**The state of it.** Roughly a dozen suites were written while building this —
undo stack semantics, shape geometry and rotation, contrast ink, the ownership
rules, presence and last-seen, the account and confirmation flows, invite-key
removal, compression coverage — and every one of them lives in a scratchpad that
gets thrown away. They caught real bugs, including several of mine.

**Why it's third rather than first.** It changes nothing a player sees. It is
still the best engineering investment available, and it would have caught at
least three of the regressions hit while building the last few features.

**Steps**

1. **`server/test/`**, using `node --test` — already available, no dependency.
2. **Port the suites that test rules rather than wiring**: the ownership rules,
   the account flows, presence, the invite-key removal, compression coverage.
   These start a real server on a throwaway database and talk to it over HTTP,
   which is what made them worth having.
3. **Port the pure-function suites** as they are: `shapes.js` geometry,
   `history.js` stack semantics, `timeAgo.js`. These need no server at all.
4. **`npm test` at the root**, running both halves.
5. **A short note in the README** on how to run them and what they cover.

**Done when** `npm test` runs green from a clean checkout and a broken permission
rule fails it.

---

## 4. Two smaller things

**Turn mode is undocumented.** The README describes the map, the drawing layer,
undo, accounts and mail, but not turn mode or the tools panel that opens it — a
pre-existing gap I left alone rather than widening the scope of the docs pass.

**The tunnel instability is mitigated, not diagnosed.** The vanishing data can no
longer happen — a dropped socket asks whether the server is there instead of
assuming it isn't — and the payload that triggered it is about eight times
smaller. But what actually drops on the tunnel was never confirmed. If it
recurs, that deserves a proper look with the deployed console open rather than
another guess.
