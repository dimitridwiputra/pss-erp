import { useId } from 'react';

export type SelectionOption = {
  value: string;
  label: string;
  description?: string;
};

export type SelectionCardGroupProps = {
  label: string;
  name: string;
  options: readonly SelectionOption[];
  value: string | undefined;
  onValueChange: (value: string) => void;
  state?: 'default' | 'loading' | 'disabled' | 'error';
  errorMessage?: string;
  required?: boolean;
  className?: string;
};

/** A single choice with a large target; native radio controls keep keyboard behavior. */
export function SelectionCardGroup({
  label,
  name,
  options,
  value,
  onValueChange,
  state = 'default',
  errorMessage,
  required = false,
  className = '',
}: SelectionCardGroupProps) {
  const errorId = useId();
  const unavailable = state === 'loading' || state === 'disabled';

  return (
    <fieldset className={`pss-selection-group ${className}`.trim()} disabled={unavailable} aria-describedby={state === 'error' && errorMessage ? errorId : undefined}>
      <legend>{label}{required && <span aria-hidden="true"> *</span>}</legend>
      {state === 'loading' && <p className="pss-selection-hint" role="status">Pilihan sedang dimuat…</p>}
      <div className="pss-selection-options">
        {options.map((option) => (
          <label className="pss-selection-card" key={option.value}>
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onValueChange(option.value)}
              required={required}
              aria-invalid={state === 'error'}
              aria-describedby={state === 'error' && errorMessage ? errorId : undefined}
            />
            <span className="pss-selection-content">
              <span className="pss-selection-mark" aria-hidden="true">✓</span>
              <span className="pss-selection-text">
                <strong>{option.label}</strong>
                {option.description && <small>{option.description}</small>}
              </span>
            </span>
          </label>
        ))}
      </div>
      {state === 'error' && errorMessage && <p className="pss-field-error" id={errorId} role="alert">{errorMessage}</p>}
    </fieldset>
  );
}
