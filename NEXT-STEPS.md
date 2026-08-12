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

## 2. Password recovery — ✅ done

Built. **Forgotten your password?** on the sign-in screen takes a username or an
address, `POST /api/auth/forgot` answers `202 {ok:true}` to every caller alike,
and the link in the letter opens `ResetPassword.jsx` — a new page rather than the
existing confirm screen, because this one is where the password gets *chosen*.
`accountChanges.js` took a third `kind` and one new argument, as predicted.

Four decisions worth not reversing, each of which looks like an omission:

- **The reset request carries no password.** The plan's step 4 implied it, and
  it turned out to be the whole security argument: if a password were chosen at
  request time, anyone could pick one for your account and mail you a letter
  asking you to approve it. Nothing is decided until the mailbox holder decides.
- **The signup code is refused here** — the only place in the app that refuses
  it. Elsewhere it sits on top of something only the owner has; in recovery
  there is nothing underneath, so it would be a master key to every account.
- **`claimChange` now takes the kinds a route will accept**, and refuses others
  *without spending them*. A hand-edited query parameter shouldn't burn the live
  link somebody is holding.
- **A rejected password doesn't spend the link.** The validation runs before the
  claim: a mistyped eight-character rule must not cost somebody their only way
  back in, on the very screen that can no longer help them.

The no-address case (step 6) went the way the plan guessed: `POST
/api/users/:id/reset`, admin only, hands the link back rather than posting it,
behind the 🔑 in the Users tab. Not restricted to address-less accounts —
somebody who has lost the mailbox itself is exactly as stuck.

Ten suites cover it (see the note under item 3; they are in a scratchpad again).
`SMTP_PASS` was never actually a blocker: the outbox is a complete test channel,
and that is what everything was verified through. It is still needed before any
of this reaches a real player.

**Done when** — met: somebody who has forgotten their password gets back into
their own account without an admin deleting anything.

---

## 3. Bring the tests into the repo

**The state of it.** Roughly a dozen suites were written while building this —
undo stack semantics, shape geometry and rotation, contrast ink, the ownership
rules, presence and last-seen, the account and confirmation flows, invite-key
removal, compression coverage — and every one of them lives in a scratchpad that
gets thrown away. They caught real bugs, including several of mine.

**Why it was third, and is now first.** It changes nothing a player sees, which
is why it kept losing to things that did. With the two above it built and
thrown away, it is what's left — and the argument for it has got stronger each
time: the recovery suites caught the spent-link-on-a-rejected-password bug, and
they are already gone too.

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
