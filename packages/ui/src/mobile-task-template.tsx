import type { ReactNode } from 'react';

export type MobileTaskTemplateProps = {
  context: string;
  instruction: string;
  object: ReactNode;
  details?: ReactNode;
  action: ReactNode;
  feedback?: ReactNode;
};

export function MobileTaskTemplate({ context, instruction, object, details, action, feedback }: MobileTaskTemplateProps) {
  return (
    <main className="pss-page-template pss-mobile-task">
      <header className="pss-template-header"><p className="pss-template-eyebrow">{context}</p><h1>{instruction}</h1></header>
      <section aria-label="Pekerjaan saat ini" className="pss-template-panel">{object}</section>
      {details && <section aria-label="Informasi tambahan" className="pss-template-details">{details}</section>}
      {feedback && <div className="pss-template-feedback" role="status">{feedback}</div>}
      <footer className="pss-mobile-action">{action}</footer>
    </main>
  );
}
