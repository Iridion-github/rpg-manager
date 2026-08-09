// Small labelled inputs, so the sheet reads as a sheet rather than as markup.

export function Text({ label, value, onChange, readOnly, placeholder, className = '' }) {
  return (
    <label className={`fld ${className}`}>
      <input
        type="text"
        value={value ?? ''}
        placeholder={placeholder}
        disabled={readOnly}
        onChange={(e) => onChange(e.target.value)}
      />
      <span>{label}</span>
    </label>
  );
}

export function Num({ label, value, onChange, readOnly, min, max, className = '' }) {
  return (
    <label className={`fld num ${className}`}>
      <input
        type="number"
        value={value ?? 0}
        min={min}
        max={max}
        disabled={readOnly}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
      />
      <span>{label}</span>
    </label>
  );
}

export function Area({ label, value, onChange, readOnly, rows = 4, className = '' }) {
  return (
    <label className={`fld area ${className}`}>
      <textarea
        rows={rows}
        value={value ?? ''}
        disabled={readOnly}
        onChange={(e) => onChange(e.target.value)}
      />
      <span>{label}</span>
    </label>
  );
}

export function Select({ label, value, onChange, readOnly, options, blank = '—' }) {
  return (
    <label className="fld">
      <select value={value ?? ''} disabled={readOnly} onChange={(e) => onChange(e.target.value)}>
        <option value="">{blank}</option>
        {options.map((o) => (
          <option key={o.value ?? o} value={o.value ?? o}>
            {o.label ?? o}
          </option>
        ))}
      </select>
      <span>{label}</span>
    </label>
  );
}

// A boxed, derived number — the things the paper sheet makes you work out.
/**
 * A derived number in a box. Pass `onClick` and the *caption* becomes the
 * button, not the box — same shape as the skills list, where the name rolls and
 * the number beside it is just a number. A whole-box button would swallow the
 * value along with it.
 */
export function Stat({ label, value, hint, onClick }) {
  return (
    <div className="stat-box" title={hint}>
      <b>{value}</b>
      {onClick ? (
        <button type="button" className="rollable stat-roll" title={`Roll ${label}`} onClick={onClick}>
          {label}
        </button>
      ) : (
        <span>{label}</span>
      )}
    </div>
  );
}
