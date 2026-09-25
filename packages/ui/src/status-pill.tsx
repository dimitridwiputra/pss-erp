export type StatusPillProps = {
  label: string;
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  state?: 'default' | 'loading' | 'disabled' | 'error';
};

export function StatusPill({ label, tone = 'neutral', state = 'default' }: StatusPillProps) {
  const visibleLabel = state === 'loading' ? 'Sedang memuat…' : label;
  return <span className={`pss-status-pill pss-status-${tone} pss-status-state-${state}`} role="status" aria-disabled={state === 'disabled'}>{visibleLabel}</span>;
}
