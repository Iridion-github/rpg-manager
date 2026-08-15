import { useState } from 'react';
import { Text, Num, Area, Select, Stat } from './fields.jsx';
import ConfirmDeleteModal from '../ConfirmDeleteModal.jsx';
import DiceModal from '../DiceModal.jsx';
import RollConfirmModal from '../RollConfirmModal.jsx';
import PicturePicker from '../PicturePicker.jsx';
import { api } from '../api.js';
import { TO_HIT_DICE, DAMAGE_DICE, notation } from '../dice.js';
import { attackRollLabels, characterRollLabel, spellRollLabels } from './rollLabels.js';
import GlobalModifiers from './GlobalModifiers.jsx';
import AcModifiers from './AcModifiers.jsx';
import EquippedArmor from './EquippedArmor.jsx';
import ItemList from './ItemList.jsx';
import SpellRow from './SpellRow.jsx';
import Shareable, { SharePreviewModal, shareProps } from './Shareable.jsx';
import {
  shareAbility,
  shareAcModifiers,
  shareAppearance,
  shareArmorClass,
  shareArmorPiece,
  shareAttack,
  shareCurrency,
  shareFeature,
  shareGlobalModifiers,
  shareDeathSaves,
  shareHitDice,
  shareHitPoints,
  shareField,
  shareInspiration,
  shareInitiative,
  shareInventoryItem,
  sharePassivePerception,
  shareProficiency,
  shareProficiencyBonus,
  shareProse,
  shareSkill,
  shareSave,
  shareSpeed,
  shareSpell,
  shareSpellSlots,
  shareSpellcasting,
} from './shareText.js';
import {
  ABILITIES,
  SKILLS,
  ALIGNMENTS,
  SPELL_LEVELS,
  abilityMod,
  blankSpell,
  acModifiers,
  acOther,
  activeAcModifiers,
  activeModifiers,
  armorClass,
  armorClassBreakdown,
  extrasNotation,
  featureRows,
  inventoryRows,
  inventoryWeight,
  modifierExtras,
  proficiencyRows,
  specAbilityBonus,
  proficiencyBonus,
  signed,
  saveBonus,
  skillBonus,
  stealthDisadvantage,
  passivePerception,
  initiative,
  spellSaveDc,
  spellAttackBonus,
  spellToHitBonus,
} from './rules.js';

/**
 * Write one value into a copy of the sheet, at a dotted path.
 *
 * As deep as it is given rather than the three levels it used to unroll by
 * hand: `spellcasting.slots.3.total` is four, and the hand-written version
 * quietly wrote the number over the whole slot instead - which is why typing a
 * number of spell slots did nothing and took the used count with it.
 *
 * Whatever is not an object on the way down is replaced by one, so a path into
 * a sheet that has never held that section still arrives.
 */
function setIn(obj, path, value) {
  const [head, ...rest] = path.split('.');
  const base = obj && typeof obj === 'object' ? obj : {};
  if (!rest.length) return { ...base, [head]: value };
  return { ...base, [head]: setIn(base[head], rest.join('.'), value) };
}

const uid = () => crypto.randomUUID();

/**
 * What a row is made of, in each of the three sections that are lists.
 *
 * Kept here, beside the sections they belong to, rather than inside the list
 * component: what a proficiency has on it is a fact about a character sheet,
 * and ItemList is only the thing that draws rows. The order is the order they
 * appear in; `grow` is the field that takes the slack, and the areas fall
 * underneath whatever sits on the first line. See ItemList.
 */
const PROFICIENCY_FIELDS = [
  { key: 'title', label: 'Title', kind: 'text', width: 'grow', placeholder: "Thieves' tools" },
  { key: 'subtitle', label: 'Subtitle', kind: 'text', placeholder: 'Optional' },
  { key: 'description', label: 'Description', kind: 'area', rows: 2, placeholder: 'Optional' },
];

const INVENTORY_FIELDS = [
  // Quantity leads, because that is the order the line is read in: two daggers,
  // not daggers, two.
  { key: 'quantity', label: 'Qty', kind: 'int', width: 'narrow', placeholder: '–' },
  { key: 'title', label: 'Item', kind: 'text', width: 'grow', placeholder: 'Rope, 50 ft' },
  { key: 'weight', label: 'Weight', kind: 'num', width: 'narrow', placeholder: '–' },
];

/**
 * What the kit comes to, printed beside the Inventory heading.
 *
 * Absent, not zero, on a sheet where nobody has written a weight down: a table
 * that ignores encumbrance should not have a running total of nothing sitting
 * on their sheet. No unit, because the column it adds up hasn't got one either
 * - the sheet doesn't know whether this table counts in pounds.
 */
function CarriedWeight({ sheet }) {
  const total = inventoryWeight(sheet);
  if (total === null) return null;
  return (
    <span className="item-total" title="Each row's weight times how many of it there are">
      Total weight: <b>{total}</b>
    </span>
  );
}

const FEATURE_FIELDS = [
  { key: 'title', label: 'Title', kind: 'text', width: 'grow', placeholder: 'Darkvision' },
  { key: 'source', label: 'Source', kind: 'text', placeholder: 'Race, class, feat…' },
  {
    key: 'description',
    label: 'Description',
    kind: 'area',
    rows: 3,
    placeholder: 'What it does, and when',
  },
];

export default function CharacterSheet({ sheet, onChange, readOnly }) {
  const [page, setPage] = useState('main');
  // A roll waiting to be confirmed: { title, rolls, allowAdvantage }.
  const [confirming, setConfirming] = useState(null);

  /**
   * Sharing mode: the sheet as something you point at rather than fill in.
   *
   * One mode rather than a share button beside every section, because there
   * would be forty of them and the sheet is crowded enough. While it is on,
   * every part worth quoting lights up and takes the click, and nothing on the
   * sheet can be edited or rolled - see `locked` below, and Shareable.jsx.
   */
  const [sharing, setSharing] = useState(false);
  // The block waiting to be confirmed: { title, text }.
  const [preview, setPreview] = useState(null);
  const [sendingShare, setSendingShare] = useState(false);
  const [shareError, setShareError] = useState('');

  const set = (path) => (value) => onChange(setIn(sheet, path, value));
  const pb = proficiencyBonus(sheet.level);

  /**
   * Hands off, whichever reason there is for it.
   *
   * A sheet somebody may only read and a sheet in sharing mode want the same
   * thing from every field on it: show the value, take no input. Passing one
   * flag means no field has to know which of the two it is - and it is what
   * keeps a click in sharing mode from landing in a text box instead of
   * sharing the section it is in.
   */
  const locked = readOnly || sharing;

  // The identity boxes at the top all take the same two props; only their
  // payload differs.
  const identity = (payload) => ({ sharing, share: payload, onPick: setPreview });

  async function sendShare() {
    if (!preview || sendingShare) return;
    setSendingShare(true);
    setShareError('');
    try {
      await api.shareToChat(preview);
      // Only the dialog closes. The mode stays on, because somebody showing
      // the table their character is usually showing it more than one thing.
      setPreview(null);
    } catch (err) {
      setShareError(err.message);
    } finally {
      setSendingShare(false);
    }
  }

  /**
   * A d20 check against some bonus - abilities, saves and skills all share it.
   *
   * `note` is a reason the dialog should open on Disadvantage rather than
   * Normal: armour that drags Stealth down, so far. It is a default and not a
   * rule, because whether this particular attempt is hampered is the table's
   * call and not the sheet's - so the dialog says where it came from and lets
   * it be changed.
   */
  const askCheck = (what, modifier, note = '') =>
    setConfirming({
      title: what,
      allowAdvantage: true,
      disadvantageNote: note,
      rolls: [
        {
          key: 'check',
          label: what,
          logLabel: what,
          advantage: true,
          spec: { count: 1, sides: 20, modifier },
        },
      ],
    });

  const askAttack = (attack) => {
    const names = attackRollLabels(attack);
    const type = (attack.damageType || '').trim();
    // The global modifiers in force, split by which half of the attack each
    // one lands on. Worked out here rather than in the dialog so that what is
    // confirmed and what is sent are built from one list.
    const effects = activeModifiers(sheet);
    const rolls = [];
    if (attack.toHit) {
      rolls.push({
        key: 'toHit',
        label: 'To hit',
        logLabel: names.toHit,
        advantage: true,
        spec: attack.toHit,
        // Kept beside the spec rather than added into it, so the dialog can
        // print the two terms the sheet prints. They are added together at the
        // moment of rolling, which is the only place one number is wanted.
        abilityBonus: specAbilityBonus(sheet, attack.toHit),
        extras: modifierExtras(effects, 'toHit'),
      });
    }
    if (attack.damage) {
      rolls.push({
        key: 'damage',
        label: type ? `Damage (${type})` : 'Damage',
        logLabel: names.damage,
        advantage: false,
        spec: attack.damage,
        abilityBonus: specAbilityBonus(sheet, attack.damage),
        extras: modifierExtras(effects, 'damage'),
      });
    }
    if (!rolls.length) return; // nothing set on this attack yet
    setConfirming({
      title: attack.name || 'Attack',
      allowAdvantage: Boolean(attack.toHit),
      rolls,
    });
  };

  /**
   * The same, for a spell.
   *
   * Built beside the attacks rather than shared with them, because the two
   * differ in exactly the place that matters: a spell's attack roll carries the
   * character's spell attack bonus, which is proficiency plus their casting
   * ability and is nothing an attack knows about. Everything else - the global
   * modifiers riding along, the labels the chat gets - is the same, and comes
   * from the same two helpers.
   */
  const askSpell = (spell) => {
    const names = spellRollLabels(spell);
    const effect = (spell.damageEffect || '').trim();
    const effects = activeModifiers(sheet);
    const rolls = [];
    if (spell.toHit) {
      rolls.push({
        key: 'toHit',
        label: 'To hit',
        logLabel: names.toHit,
        advantage: true,
        spec: spell.toHit,
        abilityBonus: spellToHitBonus(sheet, spell),
        extras: modifierExtras(effects, 'toHit'),
      });
    }
    if (spell.damage) {
      rolls.push({
        key: 'damage',
        label: effect ? `Damage (${effect})` : 'Damage',
        logLabel: names.damage,
        advantage: false,
        spec: spell.damage,
        abilityBonus: specAbilityBonus(sheet, spell.damage),
        extras: modifierExtras(effects, 'damage'),
      });
    }
    if (!rolls.length) return; // nothing set on this spell yet
    setConfirming({
      title: spell.name || 'Spell',
      allowAdvantage: Boolean(spell.toHit),
      rolls,
    });
  };

  // Posting a roll puts it in the chat - for the whole table, or for the DM
  // alone. Each roll carries its own log label, so what appears never depends
  // on how many rolls happened to be in the batch; `secret` applies to all of
  // them, since half a hidden attack is not hidden.
  async function runRolls({ swing, secret, skipped }) {
    for (const r of confirming.rolls) {
      // The ability's modifier is added into the roll's own here, where one
      // number is what is wanted. `ability` itself is dropped rather than sent:
      // it is a question about a character, and the roller knows nothing about
      // characters.
      const { ability, modifier = 0, ...spec } = r.spec;
      await api.rollDice({
        ...spec,
        modifier: modifier + (r.abilityBonus || 0),
        // `r.advantage` is whether this roll can swing at all - a d20 can, the
        // damage die it is followed by cannot - and the chosen swing is what
        // it does when it can.
        advantage: r.advantage && swing === 'advantage',
        disadvantage: r.advantage && swing === 'disadvantage',
        secret,
        label: characterRollLabel(sheet.name, r.logLabel),
        // Whatever the dialog left ticked. Skipping is per effect rather than
        // per roll, so turning Bless off for this attack turns it off on both
        // halves of it - it is one spell, not two.
        extras: (r.extras || []).filter((x) => !skipped?.has(x.id)),
      });
    }
  }

  return (
    <div className={`sheet-full${sharing ? ' sharing' : ''}`}>
      <nav className="sheet-pages">
        {[
          ['main', 'Character'],
          ['details', 'Details'],
          ['spells', 'Spellcasting'],
        ].map(([key, label]) => (
          <button key={key} className={page === key ? 'active' : ''} onClick={() => setPage(key)}>
            {label}
          </button>
        ))}
        <div className="spacer" />
        {/* The pages are where you are; this is what the sheet is *for* right
            now, so it sits at the other end of the same row rather than in the
            middle of them. Its label is the way out, because while the mode is
            on the whole sheet is already saying it is on. */}
        <button
          className={`share-mode-toggle${sharing ? ' on' : ''}`}
          aria-pressed={sharing}
          onClick={() => {
            setSharing((on) => !on);
            setPreview(null);
          }}
          title={
            sharing
              ? 'Go back to reading and editing the sheet'
              : 'Click any part of the sheet to show it to the table'
          }
        >
          {sharing ? 'Exit Sharing mode' : 'Enter Sharing mode'}
        </button>
      </nav>

      {sharing && (
        <p className="hint share-hint">
          Click any part of the sheet to show it in the chat. Nothing can be edited or rolled until
          you leave.
        </p>
      )}

      <header className="sheet-top">
        {/* The character's own face, first thing on the sheet. Read-only for
            somebody who may look at this sheet but not change it, which leaves
            the portrait and takes the controls under it away. */}
        <PicturePicker
          url={sheet.portraitUrl || ''}
          onChange={set('portraitUrl')}
          disabled={locked}
          // Taller than it is wide, which is the shape a person is. The cropper
          // is cut to the same three-by-four, so what is saved fills the frame
          // here and the thumbnail on the card without either one guessing.
          aspect={3 / 4}
          cropTitle="Frame the portrait"
          alt={sheet.name || 'Character portrait'}
          placeholder="No portrait"
        />
        {/* The name and the eight facts under it, in one grid rather than a
            column each. Beside a portrait this tall they were a short block of
            fields with a hand's depth of nothing under them; as one grid they
            share the portrait's height between them, which is what the boxes on
            a printed sheet do. */}
        {/* Nine boxes, and nine things to share: the name spans the row and the
            rest fill the grid, in sharing mode exactly as out of it. Each
            wrapper stands in for the cell its field was, which is what the
            class on the name is for. */}
        <div className="sheet-identity">
          <Shareable
            sharing={sharing}
            share={shareField(sheet, 'Character name', sheet.name)}
            onPick={setPreview}
            className="char-name-cell"
          >
            <label className="fld char-name">
              <input
                type="text"
                value={sheet.name ?? ''}
                placeholder="Character name"
                disabled={locked}
                onChange={(e) => set('name')(e.target.value)}
              />
              <span>Character name</span>
            </label>
          </Shareable>
          <Shareable {...identity(shareField(sheet, 'Class', sheet.class))}>
            <Text label="Class" value={sheet.class} onChange={set('class')} readOnly={locked} />
          </Shareable>
          <Shareable {...identity(shareField(sheet, 'Level', sheet.level))}>
            <Num label="Level" value={sheet.level} onChange={set('level')} readOnly={locked} min={1} max={20} />
          </Shareable>
          <Shareable {...identity(shareField(sheet, 'Subclass', sheet.subclass))}>
            <Text label="Subclass" value={sheet.subclass} onChange={set('subclass')} readOnly={locked} />
          </Shareable>
          <Shareable {...identity(shareField(sheet, 'Background', sheet.background))}>
            <Text label="Background" value={sheet.background} onChange={set('background')} readOnly={locked} />
          </Shareable>
          <Shareable {...identity(shareField(sheet, 'Race', sheet.race))}>
            <Text label="Race" value={sheet.race} onChange={set('race')} readOnly={locked} />
          </Shareable>
          <Shareable {...identity(shareField(sheet, 'Alignment', sheet.alignment))}>
            <Select
              label="Alignment"
              value={sheet.alignment}
              onChange={set('alignment')}
              readOnly={locked}
              options={ALIGNMENTS}
            />
          </Shareable>
          <Shareable {...identity(shareField(sheet, 'Player', sheet.playerName))}>
            <Text label="Player" value={sheet.playerName} onChange={set('playerName')} readOnly={locked} />
          </Shareable>
          <Shareable {...identity(shareField(sheet, 'XP', sheet.xp))}>
            <Num label="XP" value={sheet.xp} onChange={set('xp')} readOnly={locked} min={0} />
          </Shareable>
        </div>
      </header>

      {page === 'main' && (
        <MainPage
          sheet={sheet}
          set={set}
          onChange={onChange}
          readOnly={locked}
          pb={pb}
          askCheck={askCheck}
          askAttack={askAttack}
          sharing={sharing}
          onPick={setPreview}
        />
      )}
      {page === 'details' && (
        <DetailsPage
          sheet={sheet}
          set={set}
          readOnly={locked}
          sharing={sharing}
          onPick={setPreview}
        />
      )}
      {page === 'spells' && (
        <SpellsPage
          sheet={sheet}
          set={set}
          onChange={onChange}
          readOnly={locked}
          sharing={sharing}
          onPick={setPreview}
          askSpell={askSpell}
        />
      )}

      {confirming && (
        <RollConfirmModal
          title={confirming.title}
          rolls={confirming.rolls}
          allowAdvantage={confirming.allowAdvantage}
          disadvantageNote={confirming.disadvantageNote}
          onConfirm={runRolls}
          onClose={() => setConfirming(null)}
        />
      )}

      {preview && (
        <SharePreviewModal
          share={preview}
          busy={sendingShare}
          error={shareError}
          onCancel={() => {
            setPreview(null);
            setShareError('');
          }}
          onSend={sendShare}
        />
      )}
    </div>
  );
}

function MainPage({ sheet, set, onChange, readOnly, pb, askCheck, askAttack, sharing, onPick }) {
  // Every region on this page takes the same two props, so they are bundled
  // once rather than spelled out forty times.
  const share = (payload) => ({ sharing, share: payload, onPick });

  const attacks = sheet.attacks || [];
  // Which attack field is currently being picked: { id, field }.
  const [picking, setPicking] = useState(null);
  // Whether the global modifiers list is open over the sheet.
  const [editingModifiers, setEditingModifiers] = useState(false);
  // The same, for the ones that land on Armor Class.
  const [editingAc, setEditingAc] = useState(false);

  /**
   * The Armor Class modifiers, normalised.
   *
   * Read through the rules rather than off the sheet, so a character whose
   * bonus is still the single number the sheet used to hold arrives here as a
   * list like any other. Writing the whole object back rather than a path into
   * it is what turns that reading into what is stored, the first time anybody
   * touches the switch: half of it written into a sheet that has none would be
   * a switch with no list under it.
   */
  const acMods = acModifiers(sheet);
  const acTotal = acOther(sheet);
  const acNames = activeAcModifiers(sheet)
    .map((e) => e.name)
    .filter(Boolean)
    .join(', ');
  const setAcMods = (patch) => onChange({ ...sheet, acModifiers: { ...acMods, ...patch } });

  // What the attacks are carrying, said two ways: the names, for the row beside
  // the switch, and the arithmetic, for the line under it.
  const running = activeModifiers(sheet);
  const modifierNames = running
    .map((e) => e.name)
    .filter(Boolean)
    .join(', ');
  const liveToHit = extrasNotation(modifierExtras(running, 'toHit'));
  const liveDamage = extrasNotation(modifierExtras(running, 'damage'));

  const setAttack = (id, field, value) =>
    onChange({
      ...sheet,
      attacks: attacks.map((a) => (a.id === id ? { ...a, [field]: value } : a)),
    });
  const addAttack = () =>
    onChange({
      ...sheet,
      attacks: [...attacks, { id: uid(), name: '', toHit: null, damage: null, damageType: '' }],
    });
  const removeAttack = (id) =>
    onChange({ ...sheet, attacks: attacks.filter((a) => a.id !== id) });

  // Even a single row asks first. It's a line you typed, there is no undo on a
  // sheet, and the ✕ sits at the end of a row of fields you were just editing.
  const [confirmAttackId, setConfirmAttackId] = useState('');
  const confirmAttack = attacks.find((a) => a.id === confirmAttackId) || null;

  // Death saves are three boxes each - clicking the nth sets the count to n,
  // clicking the one that's already the highest clears it back down.
  const deathBoxes = (kind) => (
    <div className="death-row">
      <span>{kind === 'successes' ? 'Successes' : 'Failures'}</span>
      {[1, 2, 3].map((n) => (
        <button
          key={n}
          type="button"
          className={`pip${(sheet.deathSaves?.[kind] || 0) >= n ? ' on' : ''}`}
          disabled={readOnly}
          aria-label={`${kind} ${n}`}
          onClick={() =>
            set(`deathSaves.${kind}`)((sheet.deathSaves?.[kind] || 0) === n ? n - 1 : n)
          }
        />
      ))}
    </div>
  );

  return (
    <div className="sheet-grid">
      {/* ---- column one: abilities, saves, skills ---- */}
      <div className="sheet-col">
        <div className="ability-list">
          {ABILITIES.map((a) => (
            <Shareable key={a.key} {...share(shareAbility(sheet, a))}>
            <div className="ability">
              {/* The name is the roll handle; the score below stays editable. */}
              <button
                type="button"
                className="ability-name rollable"
                title={`Roll a ${a.label} check`}
                onClick={() => askCheck(`${a.label} check`, abilityMod(sheet.abilities?.[a.key]))}
              >
                {a.label}
              </button>
              <b className="ability-mod">{signed(abilityMod(sheet.abilities?.[a.key]))}</b>
              <input
                type="number"
                className="ability-score"
                min={1}
                max={30}
                value={sheet.abilities?.[a.key] ?? 10}
                disabled={readOnly}
                onChange={(e) => set(`abilities.${a.key}`)(Number(e.target.value) || 0)}
              />
            </div>
            </Shareable>
          ))}
        </div>

        <div className="box inline-stats">
          <Shareable {...share(shareInspiration(sheet))}>
            <label className="check">
              <input
                type="checkbox"
                checked={Boolean(sheet.inspiration)}
                disabled={readOnly}
                onChange={(e) => set('inspiration')(e.target.checked)}
              />
              Inspiration
            </label>
          </Shareable>
          <Shareable {...share(shareProficiencyBonus(sheet))}>
            <Stat label="Proficiency bonus" value={signed(pb)} hint="Derived from level" />
          </Shareable>
        </div>

        {/* One save at a time. The section as a whole is not something anybody
            shows a table - "here are all six of my saves" is a data dump, and
            what actually gets said out loud is "my Dexterity save is +7". Same
            reasoning everywhere below: the row is the unit, not the box. */}
        <div className="box">
          <h4>Saving throws</h4>
          {ABILITIES.map((a) => (
            <Shareable key={a.key} {...share(shareSave(sheet, a))}>
            <div className="prof-row">
              <input
                type="checkbox"
                checked={Boolean(sheet.saves?.[a.key])}
                disabled={readOnly}
                onChange={(e) => set(`saves.${a.key}`)(e.target.checked)}
                aria-label={`${a.label} save proficiency`}
              />
              <b>{signed(saveBonus(sheet, a.key))}</b>
              <button
                type="button"
                className="rollable"
                title={`Roll a ${a.label} saving throw`}
                onClick={() =>
                  askCheck(`${a.label} saving throw`, saveBonus(sheet, a.key))
                }
              >
                {a.label}
              </button>
            </div>
            </Shareable>
          ))}
        </div>

        <div className="box">
          <h4>Skills</h4>
          {SKILLS.map((s) => {
            const rank = Number(sheet.skills?.[s.key]) || 0;
            // The one skill the armour has an opinion about.
            const hampered = s.key === 'stealth' && stealthDisadvantage(sheet);
            return (
              <Shareable key={s.key} {...share(shareSkill(sheet, s))}>
              <div className="prof-row">
                {/* One control cycling none → proficient → expertise, which is
                    what the two little circles on the paper sheet mean. */}
                <button
                  type="button"
                  className={`rank rank-${rank}`}
                  disabled={readOnly}
                  title={['Not proficient', 'Proficient', 'Expertise'][rank]}
                  onClick={() => set(`skills.${s.key}`)((rank + 1) % 3)}
                >
                  {rank === 2 ? '◉' : rank === 1 ? '●' : '○'}
                </button>
                <b>{signed(skillBonus(sheet, s))}</b>
                <button
                  type="button"
                  className="rollable"
                  title={`Roll a ${s.label} check`}
                  onClick={() =>
                    askCheck(
                      `${s.label} check`,
                      skillBonus(sheet, s),
                      hampered ? '(Equipped armor)' : ''
                    )
                  }
                >
                  {s.label} <i>({s.ability})</i>
                </button>
              </div>
              </Shareable>
            );
          })}
        </div>

        <Shareable {...share(sharePassivePerception(sheet))}>
          <Stat label="Passive Perception" value={passivePerception(sheet)} />
        </Shareable>

        <ItemList
          title="Other proficiencies & languages"
          items={proficiencyRows(sheet)}
          onChange={set('otherProficiencies')}
          readOnly={readOnly}
          addLabel="+ Proficiency"
          emptyLabel="Nothing written down yet."
          noun="this proficiency"
          fields={PROFICIENCY_FIELDS}
          sharing={sharing}
          onPick={onPick}
          shareRow={(row) => shareProficiency(sheet, row)}
        />
      </div>

      {/* ---- column two: combat ---- */}
      <div className="sheet-col">
        <div className="combat-row">
          {/* Worked out rather than typed, like every other derived number on
              this sheet: it is the armour below, plus Dexterity, plus the list
              under it, and a number somebody typed here would be free to
              disagree with all three. */}
          <Shareable {...share(shareArmorClass(sheet))}>
            <Stat
              label="Armor Class"
              value={armorClass(sheet)}
              hint={armorClassBreakdown(sheet)}
            />
          </Shareable>
          <Shareable {...share(shareInitiative(sheet))}>
            <Stat
              label="Initiative"
              value={signed(initiative(sheet))}
              hint="DEX modifier + bonus"
              onClick={() => askCheck('Initiative', initiative(sheet))}
            />
          </Shareable>
          <Shareable {...share(shareSpeed(sheet))}>
            <Text label="Speed" value={sheet.speed} onChange={set('speed')} readOnly={readOnly} />
          </Shareable>
        </div>

        {/* Directly under the number it changes, and worked the same way as the
            global modifiers under the attacks: ticking the box is what opens
            the list the first time, Edit is what reopens it afterwards, and the
            names of what is running are printed where they can be read without
            opening anything. */}
        <Shareable {...share(shareAcModifiers(sheet))}>
        <div className="gm-row-inline ac-mods-row">
          <label className="check">
            <input
              type="checkbox"
              checked={Boolean(acMods.on)}
              disabled={readOnly}
              onChange={(e) => {
                setAcMods({ on: e.target.checked });
                if (e.target.checked) setEditingAc(true);
              }}
            />
            AC modifiers
          </label>
          {acNames && <small className="gm-names">{acNames}</small>}
          {acTotal !== 0 && <small className="gm-live">{signed(acTotal)}</small>}
          {!readOnly && acMods.on && (
            <button type="button" className="linky" onClick={() => setEditingAc(true)}>
              Edit
            </button>
          )}
        </div>
        </Shareable>

        {editingAc && (
          <AcModifiers
            effects={acMods.effects}
            onClose={() => setEditingAc(false)}
            onSave={(effects) => {
              setAcMods({ effects });
              setEditingAc(false);
            }}
          />
        )}

        <Shareable {...share(shareHitPoints(sheet))}>
          <div className="box hp-box">
            <h4>Hit points</h4>
            <div className="hp-row">
              <Num label="Current" value={sheet.hp?.current} onChange={set('hp.current')} readOnly={readOnly} />
              <Num label="Maximum" value={sheet.hp?.max} onChange={set('hp.max')} readOnly={readOnly} />
              <Num label="Temporary" value={sheet.hp?.temp} onChange={set('hp.temp')} readOnly={readOnly} />
            </div>
            <div className="hp-bar" aria-hidden="true">
              <i style={{ width: `${hpPercent(sheet)}%` }} />
            </div>
          </div>
        </Shareable>

        <div className="box">
          <Shareable {...share(shareHitDice(sheet))}>
            <div>
              <h4>Hit dice</h4>
              <div className="hp-row">
                <Text label="Die" value={sheet.hitDice?.die} onChange={set('hitDice.die')} readOnly={readOnly} />
                <Num label="Total" value={sheet.hitDice?.total} onChange={set('hitDice.total')} readOnly={readOnly} />
                <Num label="Used" value={sheet.hitDice?.used} onChange={set('hitDice.used')} readOnly={readOnly} />
              </div>
            </div>
          </Shareable>
          <Shareable {...share(shareDeathSaves(sheet))}>
            <div>
              <h4>Death saves</h4>
              {deathBoxes('successes')}
              {deathBoxes('failures')}
            </div>
          </Shareable>
        </div>

        <div className="box">
          <h4>Attacks & spellcasting</h4>
          <table className="attacks">
            {/* Fixed layout so Name takes whatever the narrow columns don't. */}
            <colgroup>
              <col className="col-roll" />
              <col />
              <col className="col-dice" />
              <col className="col-dice" />
              <col className="col-type" />
              <col className="col-del" />
            </colgroup>
            <thead>
              <tr>
                <th />
                <th>Name</th>
                <th>To hit</th>
                <th>Damage</th>
                <th>Type</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {/* A row cannot be wrapped in a div without breaking the table,
                  so each one wears the sharing behaviour instead of being put
                  inside it. Same click, same class. */}
              {attacks.map((a) => (
                <tr key={a.id} {...shareProps(share(shareAttack(sheet, a)))}>
                  <td>
                    <button
                      type="button"
                      className="roll-btn"
                      title={
                        a.toHit || a.damage
                          ? `Roll ${a.name || 'this attack'}`
                          : 'Set the dice first'
                      }
                      disabled={!a.toHit && !a.damage}
                      onClick={() => askAttack(a)}
                    >
                      🎲
                    </button>
                  </td>
                  <td>
                    <input
                      value={a.name}
                      disabled={readOnly}
                      onChange={(e) => setAttack(a.id, 'name', e.target.value)}
                    />
                  </td>
                  {/* Both dice cells read as their notation once chosen. */}
                  <td>
                    <button
                      type="button"
                      className={`dice-cell${a.toHit ? ' set' : ''}`}
                      disabled={readOnly}
                      onClick={() => setPicking({ id: a.id, field: 'toHit' })}
                    >
                      {/* The ability's own contribution shown as its own term,
                          so the cell reads the way the dialog that set it did
                          and the way the roll will. */}
                      {notation(a.toHit, specAbilityBonus(sheet, a.toHit)) || 'Set…'}
                    </button>
                  </td>
                  <td>
                    <button
                      type="button"
                      className={`dice-cell${a.damage ? ' set' : ''}`}
                      disabled={readOnly}
                      onClick={() => setPicking({ id: a.id, field: 'damage' })}
                    >
                      {notation(a.damage, specAbilityBonus(sheet, a.damage)) || 'Set…'}
                    </button>
                  </td>
                  <td>
                    <input
                      value={a.damageType || ''}
                      placeholder="fire"
                      disabled={readOnly}
                      onChange={(e) => setAttack(a.id, 'damageType', e.target.value)}
                    />
                  </td>
                  <td>
                    {!readOnly && (
                      <button
                        className="del"
                        onClick={() => setConfirmAttackId(a.id)}
                        title={a.name ? `Remove ${a.name}` : 'Remove this attack'}
                      >
                        ✕
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {attacks.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">
                    No attacks yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {!readOnly && <button onClick={addAttack}>+ Attack</button>}

          {/* Under the attacks rather than beside them, because it is about all
              of them at once: whatever is set here is added to every one of
              those dice buttons.

              Ticking the box is what opens the list the first time - it is the
              only sensible thing an empty switch can do - but Edit is what
              reopens it afterwards. Without that, the way back in would be to
              untick and retick, which turns every visit into a round trip
              through having the thing switched off. */}
          <Shareable {...share(shareGlobalModifiers(sheet))}>
          <div className="gm-row-inline">
            <label className="check">
              <input
                type="checkbox"
                checked={Boolean(sheet.globalModifiers?.on)}
                disabled={readOnly}
                onChange={(e) => {
                  set('globalModifiers.on')(e.target.checked);
                  if (e.target.checked) setEditingModifiers(true);
                }}
              />
              Global modifiers
            </label>
            {modifierNames && <small className="gm-names">{modifierNames}</small>}
            {!readOnly && sheet.globalModifiers?.on && (
              <button type="button" className="linky" onClick={() => setEditingModifiers(true)}>
                Edit
              </button>
            )}
          </div>
          {/* What every attack is currently carrying, in the same words the
              roll dialog will use. Only when there is something to say. */}
          {(liveToHit || liveDamage) && (
            <small className="gm-live">
              {liveToHit && <>To hit {liveToHit}</>}
              {liveToHit && liveDamage && <>, </>}
              {liveDamage && <>damage {liveDamage}</>}
            </small>
          )}
          </Shareable>

          {editingModifiers && (
            <GlobalModifiers
              effects={sheet.globalModifiers?.effects || []}
              onClose={() => setEditingModifiers(false)}
              onSave={(effects) => {
                set('globalModifiers.effects')(effects);
                setEditingModifiers(false);
              }}
            />
          )}

          {picking && (
            <DiceModal
              title={picking.field === 'toHit' ? 'Attack roll' : 'Damage roll'}
              // "Save", not "Roll": from here the dialog is writing the dice
              // onto the attack for later rather than rolling them now, which
              // is the one thing about it that differs from the chat's.
              confirmLabel="Save"
              allowed={picking.field === 'toHit' ? TO_HIT_DICE : DAMAGE_DICE}
              initial={attacks.find((a) => a.id === picking.id)?.[picking.field]}
              // What turns the Attribute row on, and what it reads the bonuses
              // from. Passed rather than looked up, so the dialog stays usable
              // from the chat, where there is no character.
              abilities={sheet.abilities}
              onClose={() => setPicking(null)}
              onConfirm={(spec) => setAttack(picking.id, picking.field, spec)}
            />
          )}
        </div>

        <Shareable {...share(shareCurrency(sheet))}>
          <div className="box">
            <h4>Currency</h4>
            <div className="currency">
              {['cp', 'sp', 'ep', 'gp', 'pp'].map((c) => (
                <Num
                  key={c}
                  label={c.toUpperCase()}
                  value={sheet.currency?.[c]}
                  onChange={set(`currency.${c}`)}
                  readOnly={readOnly}
                />
              ))}
            </div>
          </div>
        </Shareable>

        <EquippedArmor
          armor={sheet.armor || []}
          onChange={(armor) => onChange({ ...sheet, armor })}
          readOnly={readOnly}
          total={armorClass(sheet)}
          breakdown={armorClassBreakdown(sheet)}
          sharing={sharing}
          onPick={onPick}
          shareRow={(row) => shareArmorPiece(sheet, row)}
        />

        {/* Still stored as `equipment`: the heading changed, and nobody's kit
            should go missing over a word. */}
        <ItemList
          title="Inventory"
          items={inventoryRows(sheet)}
          onChange={set('equipment')}
          readOnly={readOnly}
          addLabel="+ Item"
          emptyLabel="Carrying nothing yet."
          noun="this item"
          fields={INVENTORY_FIELDS}
          summary={<CarriedWeight sheet={sheet} />}
          sharing={sharing}
          onPick={onPick}
          shareRow={(row) => shareInventoryItem(sheet, row)}
        />
      </div>

      {/* ---- column three: roleplay ---- */}
      <div className="sheet-col">
        {[
          ['Personality traits', 'personalityTraits', 3],
          ['Ideals', 'ideals', 3],
          ['Bonds', 'bonds', 3],
          ['Flaws', 'flaws', 3],
        ].map(([label, key, rows]) => (
          <Shareable key={key} {...share(shareProse(sheet, label, sheet[key]))}>
            <Area
              label={label}
              value={sheet[key]}
              onChange={set(key)}
              readOnly={readOnly}
              rows={rows}
            />
          </Shareable>
        ))}
        <ItemList
          title="Features & traits"
          items={featureRows(sheet)}
          onChange={set('featuresAndTraits')}
          readOnly={readOnly}
          addLabel="+ Feature"
          emptyLabel="No features written down yet."
          noun="this feature"
          fields={FEATURE_FIELDS}
          sharing={sharing}
          onPick={onPick}
          shareRow={(row) => shareFeature(sheet, row)}
        />
        <Shareable {...share(shareProse(sheet, 'Notes', sheet.notes))}>
          <Area label="Notes" value={sheet.notes} onChange={set('notes')} readOnly={readOnly} rows={5} />
        </Shareable>
      </div>

      {confirmAttack && (
        <ConfirmDeleteModal
          name={confirmAttack.name || 'this attack'}
          description="This removes the row from the sheet."
          confirmLabel="Remove attack"
          onConfirm={() => removeAttack(confirmAttack.id)}
          onClose={() => setConfirmAttackId('')}
        />
      )}
    </div>
  );
}

function hpPercent(sheet) {
  const max = Number(sheet.hp?.max) || 0;
  if (max <= 0) return 0;
  const current = Number(sheet.hp?.current) || 0;
  return Math.max(0, Math.min(100, (current / max) * 100));
}

function DetailsPage({ sheet, set, readOnly, sharing, onPick }) {
  const share = (payload) => ({ sharing, share: payload, onPick });
  // Every box on this page is a prose field, so they are drawn from one list
  // rather than written out twice each - once to render and once to share.
  const prose = (label, key, rows) => (
    <Shareable key={key} {...share(shareProse(sheet, label, sheet[key]))}>
      <Area label={label} value={sheet[key]} onChange={set(key)} readOnly={readOnly} rows={rows} />
    </Shareable>
  );

  return (
    <div className="sheet-grid two">
      <div className="sheet-col">
        <Shareable {...share(shareAppearance(sheet))}>
          <div className="box">
            <h4>Appearance</h4>
            <div className="appearance">
              {['age', 'height', 'weight', 'eyes', 'skin', 'hair'].map((k) => (
                <Text
                  key={k}
                  label={k[0].toUpperCase() + k.slice(1)}
                  value={sheet.appearance?.[k]}
                  onChange={set(`appearance.${k}`)}
                  readOnly={readOnly}
                />
              ))}
            </div>
          </div>
        </Shareable>
        {prose('Character appearance', 'appearanceNotes', 6)}
        {prose('Allies & organizations', 'alliesAndOrganizations', 6)}
      </div>
      <div className="sheet-col">
        {prose('Character backstory', 'backstory', 12)}
        {prose('Additional features & traits', 'additionalFeatures', 8)}
        {prose('Treasure', 'treasure', 6)}
      </div>
    </div>
  );
}

function SpellsPage({ sheet, set, onChange, readOnly, sharing, onPick, askSpell }) {
  const share = (payload) => ({ sharing, share: payload, onPick });
  const casting = sheet.spellcasting || {};
  const spells = casting.spells || [];
  const dc = spellSaveDc(sheet);
  const atk = spellAttackBonus(sheet);

  // A patch rather than one named field at a time: a spell has a dozen boxes
  // now, and two of them - the components - change together.
  const patchSpell = (id, patch) =>
    onChange({
      ...sheet,
      spellcasting: {
        ...casting,
        spells: spells.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      },
    });
  const addSpell = (level) =>
    onChange({
      ...sheet,
      spellcasting: { ...casting, spells: [...spells, blankSpell(level)] },
    });
  const removeSpell = (id) =>
    onChange({
      ...sheet,
      spellcasting: { ...casting, spells: spells.filter((s) => s.id !== id) },
    });

  /**
   * The slots at one level, kept honest against each other.
   *
   * Used can never run past the total, and lowering the total brings it down
   * with it: a level with two slots and three of them spent would print a
   * negative number of slots left, which is a sheet disagreeing with itself.
   */
  const setSlot = (level, field, value) => {
    const slot = casting.slots?.[level] || {};
    const total = field === 'total' ? value : Number(slot.total) || 0;
    const expended = field === 'expended' ? value : Number(slot.expended) || 0;
    set(`spellcasting.slots.${level}`)({ total, expended: Math.min(expended, total) });
  };

  // Same reasoning as the attack rows: one click, no undo.
  const [confirmSpellId, setConfirmSpellId] = useState('');
  const confirmSpell = spells.find((s) => s.id === confirmSpellId) || null;

  return (
    <div className="spells-page">
      <Shareable {...share(shareSpellcasting(sheet))}>
        <div className="box inline-stats">
          <Text label="Spellcasting class" value={casting.class} onChange={set('spellcasting.class')} readOnly={readOnly} />
          <Select
            label="Spellcasting ability"
            value={casting.ability}
            onChange={set('spellcasting.ability')}
            readOnly={readOnly}
            options={ABILITIES.map((a) => ({ value: a.key, label: a.label }))}
          />
          <Stat label="Spell save DC" value={dc ?? '-'} hint="8 + proficiency + ability modifier" />
          <Stat label="Spell attack" value={atk === null ? '-' : signed(atk)} hint="proficiency + ability modifier" />
        </div>
      </Shareable>

      <div className="spell-levels">
        {SPELL_LEVELS.map((level) => {
          // By value rather than identity: a spell that arrived with its level
          // as a string would otherwise belong to no card at all, which is a
          // spell nobody can see or delete.
          const atLevel = spells.filter((s) => (Number(s.level) || 0) === level);
          const slot = casting.slots?.[level] || {};
          return (
            <div key={level} className="box spell-level">
              <div className="spell-level-head">
                <h4>{level === 0 ? 'Cantrips' : `Level ${level}`}</h4>
                {level > 0 && (
                  <Shareable {...share(shareSpellSlots(sheet, level))}>
                  <div className="slots">
                    <Num label="Slots" value={slot.total} onChange={(v) => setSlot(level, 'total', v)} readOnly={readOnly} min={0} max={9} />
                    <Num label="Used" value={slot.expended} onChange={(v) => setSlot(level, 'expended', v)} readOnly={readOnly} min={0} max={Number(slot.total) || 0} />
                  </div>
                  </Shareable>
                )}
              </div>
              {atLevel.map((s) => (
                <SpellRow
                  key={s.id}
                  sheet={sheet}
                  spell={s}
                  readOnly={readOnly}
                  sharing={sharing}
                  share={shareSpell(sheet, s)}
                  onPick={onPick}
                  onPatch={(patch) => patchSpell(s.id, patch)}
                  onRemove={setConfirmSpellId}
                  onRoll={askSpell}
                />
              ))}
              {!readOnly && (
                <button className="add-spell" onClick={() => addSpell(level)}>
                  + Spell
                </button>
              )}
            </div>
          );
        })}
      </div>

      {confirmSpell && (
        <ConfirmDeleteModal
          name={confirmSpell.name || 'this spell'}
          description="This removes the spell from the sheet."
          confirmLabel="Remove spell"
          onConfirm={() => removeSpell(confirmSpell.id)}
          onClose={() => setConfirmSpellId('')}
        />
      )}
    </div>
  );
}
