import { useState } from 'react';
import ConfirmDeleteModal from '../ConfirmDeleteModal.jsx';
import Shareable from './Shareable.jsx';

const uid = () => crypto.randomUUID();

/**
 * A section of the sheet that is a list of things rather than a paragraph about
 * them: proficiencies, inventory, features.
 *
 * One component for all three, because they differ only in which boxes a row
 * has. Three copies of this would be three places to fix the next time a row
 * needs a delete confirmation or a placeholder - and they would drift, the way
 * a sheet's sections always do.
 *
 * `fields` is what makes each list itself. Each entry is:
 *
 *   key          where it lives on the row
 *   label        the caption under the box, as everywhere else on this sheet
 *   kind         'text' | 'int' | 'num' | 'area'
 *   width        'grow' for the field that should take the slack (the title),
 *                'narrow' for a number that needs four characters
 *   placeholder  shown in an empty box
 *
 * Everything that isn't an `area` sits on the row's first line, in the order
 * given; the areas stack underneath it. That is the whole of the layout, and it
 * is enough for all three sections: a quantity, a name and a weight read as one
 * line, and a description does not.
 */
export default function ItemList({
  title,
  items,
  fields,
  onChange,
  readOnly,
  addLabel = '+ Item',
  emptyLabel = 'Nothing here yet.',
  noun = 'this item',
  className = '',
  // What the rows add up to, if they add up to anything - drawn opposite the
  // heading. Optional, because only one of these sections has a total worth
  // printing: three languages do not come to anything.
  summary = null,
  // Sharing mode, passed straight through: each row is a thing you can show
  // the table. The section is not - "here is my whole inventory" is a data
  // dump, and what gets shown is the rope. See Shareable.jsx.
  sharing = false,
  onPick = null,
  shareRow = null,
}) {
  // Same reasoning as the armour and attack rows: one click, and a sheet has
  // no undo. The dialog names the row so that a column of identical ✕ buttons
  // can't quietly take the wrong one.
  const [confirmId, setConfirmId] = useState('');
  const confirming = items.find((i) => i.id === confirmId) || null;

  const inline = fields.filter((f) => f.kind !== 'area');
  const areas = fields.filter((f) => f.kind === 'area');

  const setField = (id, key, value) =>
    onChange(items.map((item) => (item.id === id ? { ...item, [key]: value } : item)));

  // A blank row, ready to be typed into. Every field starts empty rather than
  // at zero: an unfilled quantity is not a quantity of none.
  const add = () => {
    const row = { id: uid() };
    for (const f of fields) row[f.key] = f.kind === 'int' || f.kind === 'num' ? null : '';
    onChange([...items, row]);
  };

  return (
    <div className={`box item-box ${className}`}>
      {/* The heading and its total on one line, the total at the far end of it:
          it is an answer about the whole section, so it belongs where the
          section is named rather than at the bottom of a list you have to
          scroll past to reach. */}
      <div className="item-box-head">
        <h4>{title}</h4>
        {summary}
      </div>

      <ul className="item-list">
        {items.map((item) => (
          <Shareable
            key={item.id}
            sharing={sharing}
            share={shareRow ? shareRow(item) : null}
            onPick={onPick}
          >
          <li className="item-row">
            <div className="item-head">
              {inline.map((f) => (
                <label key={f.key} className={`fld item-field ${f.width || ''}`}>
                  <ItemInput
                    field={f}
                    value={item[f.key]}
                    readOnly={readOnly}
                    onChange={(v) => setField(item.id, f.key, v)}
                  />
                  <span>{f.label}</span>
                </label>
              ))}
              {!readOnly && (
                <button
                  className="del"
                  onClick={() => setConfirmId(item.id)}
                  title={item.title ? `Remove ${item.title}` : `Remove ${noun}`}
                >
                  ✕
                </button>
              )}
            </div>

            {areas.map((f) => (
              <label key={f.key} className="fld item-area">
                <textarea
                  rows={f.rows || 2}
                  value={item[f.key] ?? ''}
                  placeholder={f.placeholder}
                  disabled={readOnly}
                  onChange={(e) => setField(item.id, f.key, e.target.value)}
                />
                <span>{f.label}</span>
              </label>
            ))}
          </li>
          </Shareable>
        ))}
        {items.length === 0 && <li className="empty">{emptyLabel}</li>}
      </ul>

      {!readOnly && <button onClick={add}>{addLabel}</button>}

      {confirming && (
        <ConfirmDeleteModal
          name={confirming.title || noun}
          description="This removes the row from the sheet."
          confirmLabel="Remove"
          onConfirm={() => onChange(items.filter((i) => i.id !== confirming.id))}
          onClose={() => setConfirmId('')}
        />
      )}
    </div>
  );
}

/**
 * One box on a row.
 *
 * The numbers are deliberately not the sheet's own Num field, which answers
 * zero for an empty box. Here empty is an answer: a rope with no weight
 * written down is a rope somebody has not weighed, and printing 0 lb against
 * it would be the sheet inventing a fact. So the value stays a string in the
 * input and becomes null the moment it is cleared.
 */
function ItemInput({ field, value, readOnly, onChange }) {
  if (field.kind === 'int' || field.kind === 'num') {
    return (
      <input
        type="number"
        inputMode={field.kind === 'int' ? 'numeric' : 'decimal'}
        step={field.kind === 'int' ? 1 : 'any'}
        min={0}
        value={value ?? ''}
        placeholder={field.placeholder}
        disabled={readOnly}
        onChange={(e) => {
          const raw = e.target.value;
          onChange(raw === '' ? null : Number(raw));
        }}
      />
    );
  }
  return (
    <input
      type="text"
      value={value ?? ''}
      placeholder={field.placeholder}
      disabled={readOnly}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
