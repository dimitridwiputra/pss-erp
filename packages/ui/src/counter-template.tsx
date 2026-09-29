import type { ReactNode } from 'react';

export type CounterTemplateProps = {
  context: string;
  status?: ReactNode;
  scan: ReactNode;
  lines: ReactNode;
  summary: ReactNode;
  primaryAction: ReactNode;
  secondaryActions?: ReactNode;
  feedback?: ReactNode;
};

/**
 * Template E — Counter (POS-000.R10, OD-197 pending final visual sign-off). One primary action
 * per step, at most 3 visible actions, scan-first input. Single column from a 375px phone up
 * through a two-column tablet/desktop counter layout (packages/ui/components.css media query).
 */
export function CounterTemplate({ context, status, scan, lines, summary, primaryAction, secondaryActions, feedback }: CounterTemplateProps) {
  return (
    <main className="pss-page-template pss-counter">
      <header className="pss-template-header">
        <div className="pss-template-header-row">
          <p className="pss-template-eyebrow">{context}</p>
          {status}
        </div>
      </header>
      <div className="pss-counter-scan">{scan}</div>
      <div className="pss-counter-columns">
        <section aria-label="Keranjang" className="pss-template-panel pss-counter-lines">{lines}</section>
        <aside aria-label="Ringkasan" className="pss-template-panel pss-counter-summary">{summary}</aside>
      </div>
      {feedback && <div className="pss-template-feedback" role="status">{feedback}</div>}
      <footer className="pss-counter-actions">
        {secondaryActions && <div className="pss-counter-secondary-actions">{secondaryActions}</div>}
        <div className="pss-counter-primary-action">{primaryAction}</div>
      </footer>
    </main>
  );
}
