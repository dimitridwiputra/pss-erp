import { Button } from './button';

export type ConfirmationDialogProps = {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  open?: boolean;
  state?: 'default' | 'loading' | 'disabled' | 'error';
  errorMessage?: string;
};

export function ConfirmationDialog({ title, description, confirmLabel, onConfirm, onCancel, open = true, state = 'default', errorMessage }: ConfirmationDialogProps) {
  if (!open) return null;
  return (
    <div className="pss-confirmation-backdrop">
      <section className="pss-confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="pss-confirmation-title" aria-describedby="pss-confirmation-description">
        <h2 id="pss-confirmation-title">{title}</h2>
        <p id="pss-confirmation-description">{description}</p>
        {state === 'error' && errorMessage && <p className="pss-field-error" role="alert">{errorMessage}</p>}
        <div className="pss-confirmation-actions">
          <Button label="Batal" tone="secondary" onClick={onCancel} state={state === 'loading' ? 'disabled' : 'default'} />
          <Button label={confirmLabel} onClick={onConfirm} state={state} />
        </div>
      </section>
    </div>
  );
}
