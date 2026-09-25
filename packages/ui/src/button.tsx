import { useId, type ButtonHTMLAttributes } from 'react';

type ButtonState = 'default' | 'loading' | 'disabled' | 'error';

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  label: string;
  state?: ButtonState;
  tone?: 'primary' | 'secondary' | 'danger';
  errorMessage?: string;
};

export function Button({ label, state = 'default', tone = 'primary', errorMessage, className = '', disabled, ...props }: ButtonProps) {
  const isDisabled = disabled || state === 'loading' || state === 'disabled';
  const errorId = useId();
  return (
    <span className="pss-button-field">
      <button
        {...props}
        type={props.type ?? 'button'}
        className={`pss-button pss-button-${tone} ${className}`.trim()}
        disabled={isDisabled}
        aria-busy={state === 'loading'}
        aria-describedby={state === 'error' && errorMessage ? errorId : props['aria-describedby']}
      >
        {state === 'loading' ? 'Sedang memproses…' : label}
      </button>
      {state === 'error' && errorMessage && <span className="pss-field-error" id={errorId} role="alert">{errorMessage}</span>}
    </span>
  );
}
