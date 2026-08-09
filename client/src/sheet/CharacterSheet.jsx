import { useState } from 'react';
import { Text, Num, Area, Select, Stat } from './fields.jsx';
import DiceModal from '../DiceModal.jsx';
import RollConfirmModal from '../RollConfirmModal.jsx';
import { api } from '../api.js';
import { TO_HIT_DICE, DAMAGE_DICE, notation } from '../dice.js';
import { attackRollLabels, characterRollLabel } from './rollLabels.js';
import {
  ABILITIES,
  SKILLS,
  ALIGNMENTS,
  SPELL_LEVELS,
  abilityMod,
  proficiencyBonus,
  signed,
  saveBonus,
  skillBonus,
  passivePerception,
  initiative,
  spellSaveDc,
  spellAttackBonus,
} from './rules.js';

// Paths are at most three deep (spellcasting.slots.3), so a tiny setter beats
// pulling in a library.
function setIn(obj, path, value) {
  const [a, b, c] = path.split('.');
  if (b === undefined) return { ...obj, [a]: value };
  if (c === undefined) return { ...obj, [a]: { ...(obj[a] || {}), [b]: value } };
  return {
    ...obj,
    [a]: { ...(obj[a] || {}), [b]: { ...((obj[a] || {})[b] || {}), [c]: value } },
  };
}

const uid = () => crypto.randomUUID();

export default function CharacterSheet({ sheet, onChange, readOnly }) {
  const [page, setPage] = useState('main');
  // A roll waiting to be confirmed: { title, rolls, allowAdvantage }.
  const [confirming, setConfirming] = useState(null);

  const set = (path) => (value) => onChange(setIn(sheet, path, value));
  const pb = proficiencyBonus(sheet.level);

  // A d20 check against some bonus — abilities, saves and skills all share it.
  const askCheck = (what, modifier) =>
    setConfirming({
      title: what,
      allowAdvantage: true,
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
    const rolls = [];
    if (attack.toHit) {
      rolls.push({
        key: 'toHit',
        label: 'To hit',
        logLabel: names.toHit,
        advantage: true,
        spec: attack.toHit,
      });
    }
    if (attack.damage) {
      rolls.push({
        key: 'damage',
        label: type ? `Damage (${type})` : 'Damage',
        logLabel: names.damage,
        advantage: false,
        spec: attack.damage,
      });
    }
    if (!rolls.length) return; // nothing set on this attack yet
    setConfirming({
      title: attack.name || 'Attack',
      allowAdvantage: Boolean(attack.toHit),
      rolls,
    });
  };

  // Posting a roll puts it in the chat, where everyone at the table sees it.
  // Each roll carries its own log label, so what appears never depends on how
  // many rolls happened to be in the batch.
  async function runRolls(advantage) {
    for (const r of confirming.rolls) {
      await api.rollDice({
        ...r.spec,
        advantage: advantage && r.advantage,
        label: characterRollLabel(sheet.name, r.logLabel),
      });
    }
  }

  return (
    <div className="sheet-full">
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
      </nav>

      <header className="sheet-top">
        <label className="fld char-name">
          <input
            type="text"
            value={sheet.name ?? ''}
            placeholder="Character name"
            disabled={readOnly}
            onChange={(e) => set('name')(e.target.value)}
          />
          <span>Character name</span>
        </label>
        <div className="sheet-meta">
          <Text label="Class" value={sheet.class} onChange={set('class')} readOnly={readOnly} />
          <Num label="Level" value={sheet.level} onChange={set('level')} readOnly={readOnly} min={1} max={20} />
          <Text label="Subclass" value={sheet.subclass} onChange={set('subclass')} readOnly={readOnly} />
          <Text label="Background" value={sheet.background} onChange={set('background')} readOnly={readOnly} />
          <Text label="Race" value={sheet.race} onChange={set('race')} readOnly={readOnly} />
          <Select
            label="Alignment"
            value={sheet.alignment}
            onChange={set('alignment')}
            readOnly={readOnly}
            options={ALIGNMENTS}
          />
          <Text label="Player" value={sheet.playerName} onChange={set('playerName')} readOnly={readOnly} />
          <Num label="XP" value={sheet.xp} onChange={set('xp')} readOnly={readOnly} min={0} />
        </div>
      </header>

      {page === 'main' && (
        <MainPage
          sheet={sheet}
          set={set}
          onChange={onChange}
          readOnly={readOnly}
          pb={pb}
          askCheck={askCheck}
          askAttack={askAttack}
        />
      )}
      {page === 'details' && <DetailsPage sheet={sheet} set={set} readOnly={readOnly} />}
      {page === 'spells' && (
        <SpellsPage sheet={sheet} set={set} onChange={onChange} readOnly={readOnly} />
      )}

      {confirming && (
        <RollConfirmModal
          title={confirming.title}
          rolls={confirming.rolls}
          allowAdvantage={confirming.allowAdvantage}
          onConfirm={runRolls}
          onClose={() => setConfirming(null)}
        />
      )}
    </div>
  );
}

function MainPage({ sheet, set, onChange, readOnly, pb, askCheck, askAttack }) {
  const attacks = sheet.attacks || [];
  // Which attack field is currently being picked: { id, field }.
  const [picking, setPicking] = useState(null);

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

  // Death saves are three boxes each — clicking the nth sets the count to n,
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
            <div key={a.key} className="ability">
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
          ))}
        </div>

        <div className="box inline-stats">
          <label className="check">
            <input
              type="checkbox"
              checked={Boolean(sheet.inspiration)}
              disabled={readOnly}
              onChange={(e) => set('inspiration')(e.target.checked)}
            />
            Inspiration
          </label>
          <Stat label="Proficiency bonus" value={signed(pb)} hint="Derived from level" />
        </div>

        <div className="box">
          <h4>Saving throws</h4>
          {ABILITIES.map((a) => (
            <div key={a.key} className="prof-row">
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
          ))}
        </div>

        <div className="box">
          <h4>Skills</h4>
          {SKILLS.map((s) => {
            const rank = Number(sheet.skills?.[s.key]) || 0;
            return (
              <div key={s.key} className="prof-row">
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
                  onClick={() => askCheck(`${s.label} check`, skillBonus(sheet, s))}
                >
                  {s.label} <i>({s.ability})</i>
                </button>
              </div>
            );
          })}
        </div>

        <Stat label="Passive Perception" value={passivePerception(sheet)} />
        <Area
          label="Other proficiencies & languages"
          value={sheet.otherProficiencies}
          onChange={set('otherProficiencies')}
          readOnly={readOnly}
          rows={4}
        />
      </div>

      {/* ---- column two: combat ---- */}
      <div className="sheet-col">
        <div className="combat-row">
          <Num label="Armor Class" value={sheet.armorClass} onChange={set('armorClass')} readOnly={readOnly} />
          <Stat
            label="Initiative"
            value={signed(initiative(sheet))}
            hint="DEX modifier + bonus"
            onClick={() => askCheck('Initiative', initiative(sheet))}
          />
          <Text label="Speed" value={sheet.speed} onChange={set('speed')} readOnly={readOnly} />
        </div>

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

        <div className="box">
          <h4>Hit dice</h4>
          <div className="hp-row">
            <Text label="Die" value={sheet.hitDice?.die} onChange={set('hitDice.die')} readOnly={readOnly} />
            <Num label="Total" value={sheet.hitDice?.total} onChange={set('hitDice.total')} readOnly={readOnly} />
            <Num label="Used" value={sheet.hitDice?.used} onChange={set('hitDice.used')} readOnly={readOnly} />
          </div>
          <h4>Death saves</h4>
          {deathBoxes('successes')}
          {deathBoxes('failures')}
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
              {attacks.map((a) => (
                <tr key={a.id}>
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
                      {notation(a.toHit) || 'Set…'}
                    </button>
                  </td>
                  <td>
                    <button
                      type="button"
                      className={`dice-cell${a.damage ? ' set' : ''}`}
                      disabled={readOnly}
                      onClick={() => setPicking({ id: a.id, field: 'damage' })}
                    >
                      {notation(a.damage) || 'Set…'}
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
                      <button className="del" onClick={() => removeAttack(a.id)}>
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

          {picking && (
            <DiceModal
              title={picking.field === 'toHit' ? 'Attack roll' : 'Damage roll'}
              confirmLabel="Use"
              allowed={picking.field === 'toHit' ? TO_HIT_DICE : DAMAGE_DICE}
              initial={attacks.find((a) => a.id === picking.id)?.[picking.field]}
              onClose={() => setPicking(null)}
              onConfirm={(spec) => setAttack(picking.id, picking.field, spec)}
            />
          )}
        </div>

        <div className="box">
          <h4>Equipment</h4>
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
          <Area label="" value={sheet.equipment} onChange={set('equipment')} readOnly={readOnly} rows={6} />
        </div>
      </div>

      {/* ---- column three: roleplay ---- */}
      <div className="sheet-col">
        <Area label="Personality traits" value={sheet.personalityTraits} onChange={set('personalityTraits')} readOnly={readOnly} rows={3} />
        <Area label="Ideals" value={sheet.ideals} onChange={set('ideals')} readOnly={readOnly} rows={3} />
        <Area label="Bonds" value={sheet.bonds} onChange={set('bonds')} readOnly={readOnly} rows={3} />
        <Area label="Flaws" value={sheet.flaws} onChange={set('flaws')} readOnly={readOnly} rows={3} />
        <Area label="Features & traits" value={sheet.featuresAndTraits} onChange={set('featuresAndTraits')} readOnly={readOnly} rows={12} />
        <Area label="Notes" value={sheet.notes} onChange={set('notes')} readOnly={readOnly} rows={5} />
      </div>
    </div>
  );
}

function hpPercent(sheet) {
  const max = Number(sheet.hp?.max) || 0;
  if (max <= 0) return 0;
  const current = Number(sheet.hp?.current) || 0;
  return Math.max(0, Math.min(100, (current / max) * 100));
}

function DetailsPage({ sheet, set, readOnly }) {
  return (
    <div className="sheet-grid two">
      <div className="sheet-col">
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
        <Area label="Character appearance" value={sheet.appearanceNotes} onChange={set('appearanceNotes')} readOnly={readOnly} rows={6} />
        <Area label="Allies & organizations" value={sheet.alliesAndOrganizations} onChange={set('alliesAndOrganizations')} readOnly={readOnly} rows={6} />
      </div>
      <div className="sheet-col">
        <Area label="Character backstory" value={sheet.backstory} onChange={set('backstory')} readOnly={readOnly} rows={12} />
        <Area label="Additional features & traits" value={sheet.additionalFeatures} onChange={set('additionalFeatures')} readOnly={readOnly} rows={8} />
        <Area label="Treasure" value={sheet.treasure} onChange={set('treasure')} readOnly={readOnly} rows={6} />
      </div>
    </div>
  );
}

function SpellsPage({ sheet, set, onChange, readOnly }) {
  const casting = sheet.spellcasting || {};
  const spells = casting.spells || [];
  const dc = spellSaveDc(sheet);
  const atk = spellAttackBonus(sheet);

  const setSpell = (id, field, value) =>
    onChange({
      ...sheet,
      spellcasting: {
        ...casting,
        spells: spells.map((s) => (s.id === id ? { ...s, [field]: value } : s)),
      },
    });
  const addSpell = (level) =>
    onChange({
      ...sheet,
      spellcasting: {
        ...casting,
        spells: [...spells, { id: uid(), level, name: '', prepared: false }],
      },
    });
  const removeSpell = (id) =>
    onChange({
      ...sheet,
      spellcasting: { ...casting, spells: spells.filter((s) => s.id !== id) },
    });

  return (
    <div className="spells-page">
      <div className="box inline-stats">
        <Text label="Spellcasting class" value={casting.class} onChange={set('spellcasting.class')} readOnly={readOnly} />
        <Select
          label="Spellcasting ability"
          value={casting.ability}
          onChange={set('spellcasting.ability')}
          readOnly={readOnly}
          options={ABILITIES.map((a) => ({ value: a.key, label: a.label }))}
        />
        <Stat label="Spell save DC" value={dc ?? '—'} hint="8 + proficiency + ability modifier" />
        <Stat label="Spell attack" value={atk === null ? '—' : signed(atk)} hint="proficiency + ability modifier" />
      </div>

      <div className="spell-levels">
        {SPELL_LEVELS.map((level) => {
          const atLevel = spells.filter((s) => s.level === level);
          const slot = casting.slots?.[level] || {};
          return (
            <div key={level} className="box spell-level">
              <div className="spell-level-head">
                <h4>{level === 0 ? 'Cantrips' : `Level ${level}`}</h4>
                {level > 0 && (
                  <div className="slots">
                    <Num label="Slots" value={slot.total} onChange={set(`spellcasting.slots.${level}.total`)} readOnly={readOnly} min={0} max={9} />
                    <Num label="Used" value={slot.expended} onChange={set(`spellcasting.slots.${level}.expended`)} readOnly={readOnly} min={0} max={9} />
                  </div>
                )}
              </div>
              {atLevel.map((s) => (
                <div key={s.id} className="spell-row">
                  {level > 0 && (
                    <input
                      type="checkbox"
                      checked={Boolean(s.prepared)}
                      disabled={readOnly}
                      title="Prepared"
                      onChange={(e) => setSpell(s.id, 'prepared', e.target.checked)}
                    />
                  )}
                  <input
                    value={s.name}
                    placeholder="Spell name"
                    disabled={readOnly}
                    onChange={(e) => setSpell(s.id, 'name', e.target.value)}
                  />
                  {!readOnly && (
                    <button className="del" onClick={() => removeSpell(s.id)}>
                      ✕
                    </button>
                  )}
                </div>
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
    </div>
  );
}
