import type { FormEvent } from 'react';
import { Button } from './button';
import { TextField } from './text-field';

export type ScanScreenProps = {
  title: string;
  target: string;
  instruction: string;
  code: string;
  onCodeChange: (code: string) => void;
  onSubmitCode: () => void;
  state?: 'default' | 'loading' | 'disabled' | 'error';
  errorMessage?: string;
};

export function ScanScreen({ title, target, instruction, code, onCodeChange, onSubmitCode, state = 'default', errorMessage }: ScanScreenProps) {
  const unavailable = state === 'loading' || state === 'disabled';
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmitCode();
  }
  return (
    <section className="pss-scan-screen" aria-labelledby="pss-scan-title">
      <div className="pss-scan-heading">
        <p className="pss-scan-kicker">SCAN</p>
        <h2 id="pss-scan-title">{title}</h2>
        <p>{target}</p>
      </div>
      <div className="pss-scan-zone" role="status" aria-live="polite">
        <span className="pss-scan-frame" aria-hidden="true">⌖</span>
        <strong>{state === 'loading' ? 'Menyiapkan kamera…' : 'Arahkan kamera ke kode'}</strong>
        <span>{instruction}</span>
      </div>
      <form className="pss-scan-fallback" onSubmit={submit}>
        <TextField id="scan-code" label="Masukkan kode" value={code} onChange={(event) => onCodeChange(event.target.value)} state={state === 'error' ? 'error' : state} {...(errorMessage ? { errorMessage } : {})} />
        <Button label="Cari Kode" type="submit" state={state} />
      </form>
      {unavailable && <p className="pss-scan-hint">Selesaikan proses yang sedang berjalan untuk melanjutkan.</p>}
    </section>
  );
}
