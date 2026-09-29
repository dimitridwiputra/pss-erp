import type { ReactNode } from 'react';

export type KpiTone = 'info' | 'success' | 'warning' | 'danger' | 'neutral';

export type KpiCardProps = {
  icon: ReactNode;
  tone?: KpiTone;
  label: string;
  value: ReactNode;
  delta?: { direction: 'up' | 'down'; label: string; tone?: 'success' | 'danger' | 'neutral' };
  state?: 'default' | 'loading' | 'disabled' | 'error';
  errorMessage?: string;
};

/** A single metric tile — icon in a tinted square, big value, optional up/down delta line. */
export function KpiCard({ icon, tone = 'info', label, value, delta, state = 'default', errorMessage }: KpiCardProps) {
  const deltaTone = delta ? delta.tone ?? (delta.direction === 'up' ? 'success' : 'danger') : undefined;
  return (
    <div className={`pss-kpi-card pss-kpi-card-state-${state}`} aria-busy={state === 'loading'}>
      <span className={`pss-kpi-icon pss-kpi-icon-${state === 'disabled' ? 'neutral' : tone}`} aria-hidden="true">{icon}</span>
      <dt>{label}</dt>
      {state === 'loading' ? <dd><span className="pss-skeleton-row pss-kpi-skeleton" aria-hidden="true" /><span className="pss-visually-hidden">Sedang memuat…</span></dd>
        : state === 'error' ? <dd>—</dd>
          : <dd>{value}</dd>}
      {state === 'error' ? <p className="pss-kpi-delta pss-kpi-delta-danger">{errorMessage ?? 'Data belum dapat dimuat.'}</p>
        : delta && state === 'default' && (
          <p className={`pss-kpi-delta pss-kpi-delta-${deltaTone}`}>
            <span aria-hidden="true">{delta.direction === 'up' ? '▲' : '▼'}</span> {delta.label}
          </p>
        )}
    </div>
  );
}
