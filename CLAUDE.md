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
