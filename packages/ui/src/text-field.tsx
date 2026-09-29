import type { InputHTMLAttributes, Ref } from 'react';

export type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'children'> & {
  id: string;
  label: string;
  state?: 'default' | 'loading' | 'disabled' | 'error';
  helperText?: string;
  errorMessage?: string;
  /** React 19 passes `ref` as a normal prop to function components — no `forwardRef` needed. */
  ref?: Ref<HTMLInputElement>;
};

export function TextField({ id, label, state = 'default', helperText, errorMessage, className = '', disabled, required, ref, ...props }: TextFieldProps) {
  const descriptionId = state === 'error' && errorMessage ? `${id}-error` : state === 'loading' || helperText ? `${id}-helper` : undefined;
  return (
    <div className={`pss-text-field ${className}`.trim()}>
      <label htmlFor={id}>{label}{required && <span aria-hidden="true"> *</span>}</label>
      <input
        {...props}
        ref={ref}
        id={id}
        disabled={disabled || state === 'loading' || state === 'disabled'}
        required={required}
        aria-invalid={state === 'error'}
        aria-describedby={descriptionId}
        className={state === 'error' ? 'pss-input-error' : undefined}
      />
      {state === 'loading' && <small id={`${id}-helper`}>Sedang memuat…</small>}
      {state === 'error' && errorMessage
        ? <small id={`${id}-error`} role="alert">{errorMessage}</small>
        : state !== 'loading' && helperText && <small id={`${id}-helper`}>{helperText}</small>}
    </div>
  );
}
