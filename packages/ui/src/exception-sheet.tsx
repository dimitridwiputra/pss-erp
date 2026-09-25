import { SelectionCardGroup, type SelectionOption } from './selection-card-group';
import { Button } from './button';

export type ExceptionSheetProps = {
  title: string;
  requested: string;
  available: string;
  reasons: readonly SelectionOption[];
  selectedReason: string | undefined;
  onReasonChange: (reason: string) => void;
  onSubmit: () => void;
  state?: 'default' | 'loading' | 'disabled' | 'error';
  errorMessage?: string;
};

export function ExceptionSheet({ title, requested, available, reasons, selectedReason, onReasonChange, onSubmit, state = 'default', errorMessage }: ExceptionSheetProps) {
  return (
    <section className="pss-exception-sheet" aria-labelledby="pss-exception-title">
      <div>
        <p className="pss-scan-kicker">PERLU DICEK</p>
        <h2 id="pss-exception-title">{title}</h2>
      </div>
      <dl className="pss-exception-summary">
        <div><dt>Diminta</dt><dd>{requested}</dd></div>
        <div><dt>Ada</dt><dd>{available}</dd></div>
      </dl>
      <SelectionCardGroup label="Kenapa?" name="exception-reason" options={reasons} value={selectedReason} onValueChange={onReasonChange} state={state} {...(errorMessage ? { errorMessage } : {})} required />
      <Button label={`Laporkan ${available}`} onClick={onSubmit} state={state} />
    </section>
  );
}
