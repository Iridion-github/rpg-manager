/**
 * The control that couples a character sheet to a token.
 *
 * One component, used from both ends. In the Characters tab it asks which token
 * a character is; in the Tokens tab it asks which character a token is. Those
 * are the same fact written from two directions, so they get the same control,
 * the same wording and the same one call behind them - two bespoke pickers
 * would be two chances for the two screens to imply different rules.
 *
 * A plain select that acts on change, like the sheet access dropdowns: there is
 * nothing to compose here and nothing to get wrong halfway, so a Save button
 * would only be a second thing to press.
 *
 * Everything it knows is passed in. It does no fetching and holds no opinion
 * about who may link what - both tabs work that out from their own lists, and
 * the server checks it again regardless of what this draws.
 */
export default function SheetTokenLink({
  label,
  hint,
  value,
  options,
  emptyLabel = 'Not linked',
  busy = false,
  disabled = false,
  onChange,
}) {
  return (
    <div className="link-pair">
      <label>
        <span>{label}</span>
        <select
          value={value || ''}
          disabled={disabled || busy}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">{emptyLabel}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {/* Said in the option itself rather than as a warning after the
                  fact: choosing one of these takes it off whatever holds it,
                  and that is worth knowing before the choice, not after. */}
              {o.name}
              {o.takenBy ? ` - currently ${o.takenBy}` : ''}
            </option>
          ))}
        </select>
      </label>
      {hint && <p className="hint">{hint}</p>}
      {options.length === 0 && !value && (
        <p className="hint">Nothing here yet that you can link this to.</p>
      )}
    </div>
  );
}
