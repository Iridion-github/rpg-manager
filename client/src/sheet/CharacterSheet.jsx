import { useEffect, useState } from 'react';
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
import CompendiumButton from './CompendiumButton.jsx';
import {
  WEAPON_CATEGORIES,
  attackTemplate,
  inventoryTemplate,
} from './compendium.js';
import SpellRow from './SpellRow.jsx';
import Shareable, { SharePreviewModal, shareProps } from './Shareable.jsx';
import MediaField from './MediaField.jsx';
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
  MODIFIER_TARGETS,
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
import HpBar, { hpBar } from '../HpBar.jsx';
import AttackRow from './AttackRow.jsx';

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
 * A name you can click to roll it - or just the name, where there is nothing to
 * roll into.
 *
 * The abilities, the saves and the skills are all the same shape: a word that
 * throws a d20 at whatever bonus sits beside it. Outside a campaign there is no
 * chat log for a throw to land in, so the same word is drawn as plain text
 * instead of as a button that would look live and do nothing. One component
 * rather than three conditionals, and it takes the decision from whether the
 * handler exists, which is what `canRoll` already turns into null upstream.
 *
 * The span keeps the class it was given but drops `rollable`, which is the
 * class that supplies the pointer and the underline on hover.
 */
function Roller({ className = '', title, onClick, children }) {
  if (!onClick) return <span className={className || undefined}>{children}</span>;
  return (
    <button type="button" className={`${className} rollable`.trim()} title={title} onClick={onClick}>
      {children}
    </button>
  );
}

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
  {
    key: 'description',
    label: 'Description',
    kind: 'area',
    rows: 2,
    placeholder: 'What it does, what is in it, who it was taken from',
  },
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

export default function CharacterSheet({
  sheet,
  onChange,
  readOnly,
  canCloud = false,
  /**
   * Sharing mode, owned by whoever is drawing the window around this.
   *
   * It used to be this component's own state, with the toggle at the end of the
   * page row. The button now sits in the window's header beside Export and
   * Delete - which is a different component - so the flag has to live where
   * both of them can see it. Nothing else about the mode moved.
   */
  sharing = false,
  /**
   * Whether this sheet can throw dice.
   *
   * On at a table, where a roll goes into that table's chat log for everyone to
   * see. Off outside one, in the Characters tab in the shell: there is no table
   * listening, so a d20 thrown there would land nowhere. What that turns off is
   * the handles rather than the buttons' behaviour - the ability, save and skill
   * names stop being clickable, and the little dice beside an attack or a spell
   * are simply not drawn, rather than being drawn and refusing.
   */
  canRoll = true,
  /**
   * The campaign this character belongs to, named.
   *
   * Absent inside a campaign, where every sheet on screen is from the one you
   * are already sitting at and a box repeating its name on each of them says
   * nothing. Given outside one, where the list holds characters from every
   * table at once and which table this is is the first thing worth knowing.
   */
  campaignLabel = '',
}) {
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
   *
   * The flag comes from above; what is here is everything the mode *does*.
   */
  // The block waiting to be confirmed: { title, text }.
  const [preview, setPreview] = useState(null);
  const [sendingShare, setSendingShare] = useState(false);
  const [shareError, setShareError] = useState('');

  // Leaving the mode drops whatever was waiting to be sent. The button that
  // does the leaving is in the window header now, so this is what makes sure a
  // preview cannot outlive the mode that opened it.
  useEffect(() => {
    if (!sharing) setPreview(null);
  }, [sharing]);

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
   * A d20 check against some bonus - abilities, saves, skills and initiative
   * all share it.
   *
   * `kind` is which of the two the global modifiers should read it as, and the
   * default is the commoner one. A saving throw is the exception and says so:
   * the game treats checks and saves as different rolls, Bless helps with one
   * and Guidance with the other, so a sheet that ran them together could only
   * ever be right about half of them. Initiative counts as a check, because it
   * is a Dexterity check.
   *
   * `note` is a reason the dialog should open on Disadvantage rather than
   * Normal: armour that drags Stealth down, so far. It is a default and not a
   * rule, because whether this particular attempt is hampered is the table's
   * call and not the sheet's - so the dialog says where it came from and lets
   * it be changed.
   */
  const askCheck = (what, modifier, { kind = 'check', note = '' } = {}) =>
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
          // Whatever is riding along on this kind of roll - Guidance on a
          // check, Bless on a save. Worked out here for the same reason as on
          // an attack: what the dialog confirms and what is sent have to be
          // built from one list. The dialog lists them with a tick each, so a
          // check made without the Guidance that is technically still up costs
          // a click rather than a trip back to the sheet.
          extras: modifierExtras(activeModifiers(sheet), kind),
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
      // What this attack looks like when it lands, sent with the throw so the
      // chat can show it. On the first line only - see runRolls.
      media: attack.media || '',
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
    for (const [i, r] of confirming.rolls.entries()) {
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
        // The picture goes on the first line of the throw and no other. An
        // attack that rolls to hit and then for damage is one swing, and an
        // animation playing twice in a row in the log is one too many.
        media: i === 0 ? confirming.media || '' : '',
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
        {/* The row is the pages and nothing else now. The mode's own button is
            in the window's header, beside Export and Delete: it is a thing you
            do to the whole sheet rather than a place in it. */}
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
          // The DM's own images, offered beside the file picker. A player
          // editing their character never sees it: the cloud is prep.
          cloud={canCloud && !locked}
          cloudPurpose="as this character's portrait"
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
          {/* Which table this character is at. Last in the grid and never
              editable: it is not a thing written on the sheet but a fact about
              where the sheet lives, and moving a character between campaigns is
              not something a text box should look like it can do. Only appears
              outside a campaign - see campaignLabel. */}
          {campaignLabel && (
            <Text label="Campaign" value={campaignLabel} onChange={() => { }} readOnly />
          )}
        </div>
      </header>

      {page === 'main' && (
        <MainPage
          sheet={sheet}
          set={set}
          onChange={onChange}
          readOnly={locked}
          pb={pb}
          // Null rather than the function where there is nowhere to roll to.
          // Each page reads a missing handler as "this doesn't roll" and draws
          // the plain words instead, which is the one place the difference
          // needs deciding. See canRoll above.
          askCheck={canRoll ? askCheck : null}
          askAttack={canRoll ? askAttack : null}
          sharing={sharing}
          onPick={setPreview}
          canCloud={canCloud && !locked}
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
          askSpell={canRoll ? askSpell : null}
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

function MainPage({
  sheet,
  set,
  onChange,
  readOnly,
  pb,
  askCheck,
  askAttack,
  sharing,
  onPick,
  // Whether this campaign's own images are offered when picking an attack's
  // picture. The cloud is the DM's, so a player gets the two roads in they
  // always had: a file, or whatever they have copied.
  canCloud,
}) {
  // Every region on this page takes the same two props, so they are bundled
  // once rather than spelled out forty times.
  const share = (payload) => ({ sharing, share: payload, onPick });

  /**
   * Write one inventory row from a compendium entry.
   *
   * Through `inventoryRows` rather than off `sheet.equipment` directly, because
   * an old sheet keeps its kit as a block of text and that helper is what turns
   * it into rows with ids - the row the button belongs to may not exist as a
   * row anywhere else yet.
   */
  const setInventoryFrom = (id, node) => {
    const fields = inventoryTemplate(node);
    set('equipment')(inventoryRows(sheet).map((r) => (r.id === id ? { ...r, ...fields } : r)));
  };

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

  // What the rolls are carrying, said two ways: the names, for the row beside
  // the switch, and the arithmetic, for the line under it.
  const running = activeModifiers(sheet);
  const modifierNames = running
    .map((e) => e.name)
    .filter(Boolean)
    .join(', ');
  // One phrase per destination that has anything on it, in the order the editor
  // lists them, with only the first letter of the line capitalised: it is one
  // sentence about the sheet, not four headings.
  const liveLine = MODIFIER_TARGETS.map((t) => {
    const text = extrasNotation(modifierExtras(running, t.value));
    return text ? `${t.label.toLowerCase()} ${text}` : '';
  })
    .filter(Boolean)
    .join(', ')
    .replace(/^./, (c) => c.toUpperCase());

  const setAttack = (id, field, value) =>
    onChange({
      ...sheet,
      attacks: attacks.map((a) => (a.id === id ? { ...a, [field]: value } : a)),
    });

  /**
   * Write one attack from a compendium entry.
   *
   * Whatever the entry can say, over whatever the row already held: see
   * compendium.js, which is where the reason for each field being set or left
   * alone is written down.
   */
  const setAttackFrom = (id, node) =>
    onChange({
      ...sheet,
      attacks: attacks.map((a) => (a.id === id ? { ...a, ...attackTemplate(node) } : a)),
    });
  const addAttack = () =>
    onChange({
      ...sheet,
      attacks: [
        ...attacks,
        { id: uid(), name: '', toHit: null, damage: null, damageType: '', description: '' },
      ],
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
              <Roller
                className="ability-name"
                title={`Roll a ${a.label} check`}
                onClick={
                  askCheck &&
                  (() => askCheck(`${a.label} check`, abilityMod(sheet.abilities?.[a.key])))
                }
              >
                {a.label}
              </Roller>
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
              <Roller
                title={`Roll a ${a.label} saving throw`}
                onClick={
                  askCheck &&
                  (() =>
                    askCheck(`${a.label} saving throw`, saveBonus(sheet, a.key), { kind: 'save' }))
                }
              >
                {a.label}
              </Roller>
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
                <Roller
                  title={`Roll a ${s.label} check`}
                  onClick={
                    askCheck &&
                    (() =>
                      askCheck(`${s.label} check`, skillBonus(sheet, s), {
                        note: hampered ? '(Equipped armor)' : '',
                      }))
                  }
                >
                  {s.label} <i>({s.ability})</i>
                </Roller>
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
              onClick={askCheck && (() => askCheck('Initiative', initiative(sheet)))}
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
              {/* The battering that is not killing them. Its own box rather
                  than something taken off Current, because it heals differently
                  and because a character knocked out by it has not lost a hit
                  point. */}
              <Num
                label="Non-lethal"
                value={sheet.hp?.nonLethal}
                onChange={set('hp.nonLethal')}
                readOnly={readOnly}
                title="Damage that knocks out rather than kills"
              />
            </div>
            <HpBar
              bar={hpBar(sheet.hp?.current, sheet.hp?.max, sheet.hp?.temp, sheet.hp?.nonLethal)}
            />
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

        <div className="box item-box">
          <div className="item-box-head">
            <h4>Attacks & spellcasting</h4>
          </div>

          {/* A block each, laid out like the proficiencies and features below:
              a table gave every attack one line, and one line has room for a
              name, two dice and nothing else. What an attack actually wants
              beside it is what it looks like when it lands.

              The wrapper is Shareable rather than the row, which a table would
              not allow - one of the small freedoms of leaving the table
              behind. */}
          <ul className="item-list">
            {attacks.map((a) => (
              <Shareable
                key={a.id}
                sharing={sharing}
                share={shareAttack(sheet, a)}
                onPick={onPick}
              >
                <AttackRow
                  attack={a}
                  readOnly={readOnly}
                  // The character's own modifier for whichever ability the spec
                  // names, printed as its own term beside the dice.
                  abilityBonus={(spec) => specAbilityBonus(sheet, spec)}
                  onChange={(field, value) => setAttack(a.id, field, value)}
                  onPickDice={(field) => setPicking({ id: a.id, field })}
                  onRemove={() => setConfirmAttackId(a.id)}
                  onRoll={askAttack}
                  tools={
                    <CompendiumButton
                      title="Compendium: weapons"
                      only={WEAPON_CATEGORIES}
                      onUse={(node) => setAttackFrom(a.id, node)}
                    />
                  }
                >
                  {/* What it looks like when it lands. Kept to a thumbnail on
                      the sheet however big the file is: this is a sheet, and
                      the picture's place to be seen is the chat line the throw
                      writes. Passed in rather than built into the row, because
                      a token's attacks use the same row and have no picture. */}
                  <MediaField
                    url={a.media || ''}
                    alt={a.name ? `${a.name} in action` : 'Attack'}
                    readOnly={readOnly}
                    canCloud={canCloud}
                    animation
                    hint="shown in the chat when this is thrown"
                    onChange={(url) => setAttack(a.id, 'media', url)}
                  />
                </AttackRow>
              </Shareable>
            ))}
            {attacks.length === 0 && <li className="empty">No attacks yet.</li>}
          </ul>
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
          {/* What every roll is currently carrying, in the same words the roll
              dialog will use. Only the destinations that have something on
              them: a line that named all four every time would be mostly the
              word "nothing". */}
          {liveLine && <small className="gm-live">{liveLine}</small>}
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

      </div>

      {/* ---- column three: what the character can do, and what they carry ----

          The roleplay boxes used to live here - personality, ideals, bonds,
          flaws and the notes - and they have gone to the Details tab, where the
          rest of the prose about a character already was. What is left of this
          page is what somebody reaches for mid-turn, and it is spread across
          three columns of roughly one height rather than two long ones and a
          short one. */}
      <div className="sheet-col">
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
        <EquippedArmor
          armor={sheet.armor || []}
          onChange={(armor) => onChange({ ...sheet, armor })}
          readOnly={readOnly}
          total={armorClass(sheet)}
          breakdown={armorClassBreakdown(sheet)}
          sharing={sharing}
          onPick={onPick}
          shareRow={(row) => shareArmorPiece(sheet, row)}
          canCloud={canCloud}
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
          /* Anything at all can be carried, so nothing is filtered out here.
             The row gets the entry's name, what one of them weighs, and what
             there is to say about it; how many you have is left alone, being
             the one thing on the row the book cannot know. */
          rowTools={(row) => (
            <CompendiumButton
              title="Compendium"
              onUse={(node) => setInventoryFrom(row.id, node)}
            />
          )}
          // A picture of the thing, under each row. Stills only: a bag of kit
          // where every third line is playing an animation to itself is a list
          // nobody can read down.
          media={{ hint: 'what it looks like', canCloud }}
          summary={<CarriedWeight sheet={sheet} />}
          sharing={sharing}
          onPick={onPick}
          shareRow={(row) => shareInventoryItem(sheet, row)}
        />
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
      {/* ---- who they are ---- */}
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
        {/* The four that used to sit down the right of the Character tab. They
            are prose about a person rather than anything anybody reaches for
            mid-turn, which is what this page is, and moving them here gave the
            other one back a whole column. */}
        {prose('Personality traits', 'personalityTraits', 4)}
        {prose('Ideals', 'ideals', 4)}
        {prose('Bonds', 'bonds', 4)}
        {prose('Flaws', 'flaws', 4)}
      </div>

      {/* ---- and what has happened to them ---- */}
      <div className="sheet-col">
        {prose('Character backstory', 'backstory', 12)}
        {prose('Allies & organizations', 'alliesAndOrganizations', 6)}
        {prose('Additional features & traits', 'additionalFeatures', 8)}
        {prose('Treasure', 'treasure', 6)}
        {/* Last, and deliberately: a scratch pad is where you put what has no
            box of its own, so it belongs after every box that has one. */}
        {prose('Notes', 'notes', 6)}
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
