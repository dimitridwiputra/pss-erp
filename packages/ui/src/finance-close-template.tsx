import type { ReactNode } from 'react';

export type FinanceCloseTemplateProps = {
  period: string;
  status: string;
  progress: ReactNode;
  checklist: ReactNode;
  exceptions: ReactNode;
  report: ReactNode;
  closeAction: ReactNode;
  feedback?: ReactNode;
};

export function FinanceCloseTemplate({ period, status, progress, checklist, exceptions, report, closeAction, feedback }: FinanceCloseTemplateProps) {
  return (
    <main className="pss-page-template pss-finance-template">
      <header className="pss-template-header"><p className="pss-template-eyebrow">Tutup buku</p><h1>{period}</h1><p className="pss-template-status">{status}</p></header>
      {feedback && <div className="pss-template-feedback" role="status">{feedback}</div>}
      <section aria-labelledby="pss-close-progress" className="pss-template-panel"><h2 id="pss-close-progress">Kemajuan</h2>{progress}</section>
      <section aria-labelledby="pss-close-checklist" className="pss-template-panel"><h2 id="pss-close-checklist">Daftar pemeriksaan</h2>{checklist}</section>
      <div className="pss-template-columns">
        <section aria-labelledby="pss-close-exceptions" className="pss-template-panel"><h2 id="pss-close-exceptions">Perlu ditindaklanjuti</h2>{exceptions}</section>
        <section aria-labelledby="pss-close-report" className="pss-template-panel"><h2 id="pss-close-report">Tinjau laporan</h2>{report}</section>
      </div>
      <footer className="pss-finance-action">{closeAction}</footer>
    </main>
  );
}
