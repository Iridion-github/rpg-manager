import { PATCH_NOTES, patchDate } from './patchNotes.js';

/**
 * What has changed lately, newest first.
 *
 * A read-only page with no server behind it: the list is a module that ships
 * with the app (patchNotes.js), so it is exactly as current as the version you
 * are looking at. That is the useful property - a changelog fetched from
 * somewhere else can describe features the page it is on doesn't have.
 *
 * Grouped by day rather than by commit. Several changes usually land together,
 * and "what changed on the 11th" is the question somebody coming back after a
 * week actually asks; which of them shared a push is not.
 */

// What each tag says, and what it is for. Kept here rather than in the data so
// the wording can change without touching every entry that uses it.
const KINDS = {
  new: { label: 'New', title: 'Something you could not do before' },
  fix: { label: 'Fixed', title: 'Something that was broken' },
  change: { label: 'Changed', title: 'Something that worked before and works differently now' },
};

export default function PatchNotes() {
  return (
    <div className="patch-notes">
      <p className="hint">
        Everything worth knowing about, newest first. Dated by the day it landed; where several
        changes arrived together, they are listed under the one date.
      </p>

      {PATCH_NOTES.map((day) => (
        // A section per day, headed by the date. The heading is the date and
        // nothing else: it is what the eye scans for on this page.
        <section key={day.date} className="patch-day">
          <h3>
            <time dateTime={day.date}>{patchDate(day.date)}</time>
          </h3>
          <ul>
            {day.entries.map((entry, i) => {
              const kind = KINDS[entry.kind] || KINDS.change;
              return (
                // The index is a fine key here: the list is a constant that
                // never reorders, filters or animates - it is read off a file
                // that only ever grows at the top.
                <li key={i} className={`patch-entry ${entry.kind}`}>
                  <span className="patch-tag" title={kind.title}>
                    {kind.label}
                  </span>
                  <span>{entry.text}</span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {PATCH_NOTES.length === 0 && <p className="empty">Nothing to report yet.</p>}
    </div>
  );
}
