// A character sheet as a file: what goes in one, and what comes back out.
//
// The point of the file is that it outlives this table. A character carried to
// another campaign, kept as a backup before a level-up goes wrong, or handed to
// somebody running the same adventure - all of them are the same act, and all
// of them are somebody's character rather than this server's record of it.
//
// So what is written down is the *character*, and nothing about where it lives:
// no id, no access list, no timestamps. Those belong to the sheet this file is
// poured into, not to the file. See sheetImport, which drops them if a file
// carries them anyway.

/** How a file says what it is. Checked on the way in; written on the way out. */
export const SHEET_FILE = { app: 'rpg-manager', kind: 'character-sheet', version: 1 };

/**
 * What the app puts in this record and the file has no use for.
 *
 * `access` is the one worth naming: it is a map of user ids to what they may do,
 * which is a fact about this campaign's membership. Carrying it into a file
 * would export a list of somebody's user ids to no purpose, and importing it
 * could only ever be wrong - the sheet being written over already knows who may
 * read it, and that answer must survive being handed a new character.
 */
const NOT_THE_CHARACTER = ['id', 'access', 'createdAt', 'updatedAt'];

const withoutIdentity = (sheet) => {
  const out = { ...sheet };
  for (const key of NOT_THE_CHARACTER) delete out[key];
  return out;
};

/** The object that gets written to disk. */
export const sheetExport = (sheet) => ({
  ...SHEET_FILE,
  exportedAt: new Date().toISOString(),
  sheet: withoutIdentity(sheet),
});

/**
 * What to call the file.
 *
 * The character's name, because that is what somebody will look for in their
 * downloads folder six weeks from now - reduced to what every filesystem
 * accepts, and never empty.
 */
export function fileNameFor(sheet) {
  const base = String(sheet?.name || 'character')
    .replace(/[^a-z0-9 _-]+/gi, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return `${base || 'character'}.json`;
}

/**
 * Hand the browser a file to save.
 *
 * A blob and a link that clicks itself, which is the only way a page can offer
 * a download of something it made rather than something it fetched. The object
 * URL is released straight after: it holds the whole file in memory until it is.
 */
export function downloadSheet(sheet) {
  const blob = new Blob([JSON.stringify(sheetExport(sheet), null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileNameFor(sheet);
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * The fields that say "this is a character sheet" rather than some other JSON.
 *
 * Not all of them, and not any one of them: a sheet written by an older version
 * of this app may be missing whatever has been added since, and a file that
 * happens to have a `name` is not a character. Two of these plus a name is a
 * shape nothing else in this app produces.
 */
const SHEET_MARKERS = [
  'abilities',
  'skills',
  'saves',
  'hp',
  'hitDice',
  'attacks',
  'equipment',
  'spellcasting',
  'featuresAndTraits',
  'level',
  'class',
];

const looksLikeASheet = (value) =>
  Boolean(value) &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  typeof value.name === 'string' &&
  SHEET_MARKERS.filter((key) => key in value).length >= 2;

/**
 * Read a file back into a character, or say why it can't be one.
 *
 * Answers `{ sheet, exportedAt }` or `{ error }`, and the error is written for
 * the person holding the wrong file: which file they picked is something they
 * can fix, and "unexpected token < in JSON" is not something anybody can act on.
 *
 * Both shapes are accepted: the wrapper this app writes, and a bare sheet
 * object. The second is deliberate - somebody who has pulled a character out of
 * a campaign export by hand has a real character in their hands, and refusing it
 * over a missing envelope would be pedantry.
 */
export function readSheetFile(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'That file is not JSON. Pick the file an Export wrote.' };
  }

  if (parsed?.kind && parsed.kind !== SHEET_FILE.kind) {
    return {
      error:
        parsed.kind === 'campaign'
          ? 'That is a whole campaign, not a character. Import it from the Campaigns screen instead.'
          : 'That file is not a character sheet.',
    };
  }
  if (Number(parsed?.version) > SHEET_FILE.version) {
    return { error: 'That file was written by a newer version of this app.' };
  }

  const sheet = looksLikeASheet(parsed?.sheet)
    ? parsed.sheet
    : looksLikeASheet(parsed)
      ? parsed
      : null;
  if (!sheet) {
    return { error: 'There is no character sheet in that file.' };
  }
  return { sheet: withoutIdentity(sheet), exportedAt: parsed?.exportedAt || null };
}

/** A line describing what is in the file, for the reader to check before they commit. */
export function describeSheet(sheet) {
  const bits = [];
  if (sheet.race) bits.push(sheet.race);
  if (sheet.class) bits.push(`${sheet.class}${sheet.level ? ` ${sheet.level}` : ''}`);
  else if (sheet.level) bits.push(`level ${sheet.level}`);
  const hp = sheet.hp && typeof sheet.hp === 'object' ? sheet.hp : null;
  if (hp && (hp.max || hp.current)) bits.push(`HP ${hp.current ?? 0}/${hp.max ?? 0}`);
  return bits.join(' · ');
}
