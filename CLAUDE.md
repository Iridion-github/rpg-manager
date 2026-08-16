# Working rules for this project

Standing instructions for any Claude session working in this repository. This
file is read automatically at the start of every session, so the rules below
survive an interrupted conversation, a lost context window, or a fresh start
weeks later. They do not need to be repeated in the chat.

Rules are added here by asking for them in conversation. Keep each one short,
say what to do rather than what to avoid where possible, and give the reason:
a rule whose purpose is written down is one a later session can apply sensibly
to a case it was not written for.

---

## 1. Update the patch notes with every change

Whenever a feature is implemented or a bug is fixed, add a line to
`client/src/patchNotes.js` as part of the same piece of work. Not afterwards,
and not only when asked.

- Newest first. If today already has a group, add to it; otherwise start a new
  dated group above the last one.
- `kind` is `new` for a feature, `fix` for something that was broken, `change`
  for something that already worked and now works differently.
- Write it for the people who use the app, not for developers: one or two
  sentences about what somebody can now do, in the second person. Not how it
  was built.
- Changes nobody can see (a dependency bump, a comment pass, internal
  refactoring with no visible effect) get no line at all.

The file's own header carries the full format. The page that renders it is
`client/src/PatchNotes.jsx`, reachable from the Patch notes tab outside a
campaign.

## 2. Never use the em dash character

The character `—` is forbidden everywhere: code comments, documentation,
commit messages, patch notes, UI copy, and replies in the chat. The en dash
`–` is out for the same reason.

Use instead, depending on what the sentence is doing:

- a semicolon, when joining two related independent clauses;
- a simple hyphen `-` where a dash is genuinely wanted;
- a colon, when what follows explains or expands what came before;
- commas or parentheses, for an aside;
- or a full stop, which is very often the better answer.

This applies to new and edited text. The existing files are full of em dashes
from before the rule; they are not to be swept up wholesale, but any line
being edited for another reason should lose its em dashes on the way past.

## 3. Always include the Clipboard for img upload

Whenever an image upload system is included somewhere, unless specified otherwise, 
it should always be coupled with the existing system that lets you paste
the content of your clipboard, expecting an image, and showing a tiny red
error in case of data incompatibility.

## 4. Always restart the app when done implementing changes

Don't force the dev to restart themselves the server and app, restart it yourself 
once you're finished with the changes of the prompt.

## 5. Every date on screen reads day/month/year

Never month/day/year. The table has people from more than one country at it, and
08/12/2026 meaning two different days depending on the reader is worse than any
amount of verbosity.

Format through `client/src/dateFormat.js` (`formatDate`, `formatTime`,
`formatDateTime`) rather than calling `toLocaleDateString()` or
`toLocaleString()` with no arguments: with no locale the browser's own is used,
so the same build prints a different order to different players. Times go on the
24-hour clock for the same reason.

A date written out in words (`16 August 2026`, as the patch notes page does) is
already unambiguous and is fine where there is room for it.