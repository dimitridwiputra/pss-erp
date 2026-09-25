import type { ReactNode } from 'react';

export type ControlStationTemplateProps = {
  title: string;
  filters: ReactNode;
  kpis: ReactNode;
  exceptions: ReactNode;
  funnel: ReactNode;
  financeSummary: ReactNode;
  feedback?: ReactNode;
};

export function ControlStationTemplate({ title, filters, kpis, exceptions, funnel, financeSummary, feedback }: ControlStationTemplateProps) {
  return (
    <main className="pss-page-template pss-control-template">
      <header className="pss-template-header"><h1>{title}</h1><div className="pss-template-filters" aria-label="Periode, cabang, dan principal">{filters}</div></header>
      {feedback && <div className="pss-template-feedback" role="status">{feedback}</div>}
      <section aria-labelledby="pss-control-kpis" className="pss-template-panel"><h2 id="pss-control-kpis">Ringkasan hari ini</h2>{kpis}</section>
      <section aria-labelledby="pss-control-exceptions" className="pss-template-panel"><h2 id="pss-control-exceptions">Perlu ditindaklanjuti</h2>{exceptions}</section>
      <div className="pss-template-columns">
        <section aria-labelledby="pss-control-funnel" className="pss-template-panel"><h2 id="pss-control-funnel">Alur operasional</h2>{funnel}</section>
        <section aria-labelledby="pss-control-finance" className="pss-template-panel"><h2 id="pss-control-finance">Piutang dan keuangan</h2>{financeSummary}</section>
      </div>
    </main>
  );
}
