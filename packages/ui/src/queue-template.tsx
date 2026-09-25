import type { ReactNode } from 'react';

export type QueueTemplateProps = {
  title: string;
  count: number;
  filters: ReactNode;
  tabs: ReactNode;
  items: ReactNode;
  detail?: ReactNode;
  feedback?: ReactNode;
};

export function QueueTemplate({ title, count, filters, tabs, items, detail, feedback }: QueueTemplateProps) {
  return (
    <main className="pss-page-template pss-queue-template">
      <header className="pss-template-header pss-template-header-row"><h1>{title}</h1><span className="pss-template-count" aria-label={`${count} pekerjaan`}>{count}</span></header>
      <section aria-label="Filter antrian" className="pss-template-filters">{filters}</section>
      <nav aria-label="Kategori antrian" className="pss-template-tabs">{tabs}</nav>
      {feedback && <div className="pss-template-feedback" role="status">{feedback}</div>}
      <div className="pss-queue-content">
        <section aria-label="Daftar pekerjaan" className="pss-template-panel">{items}</section>
        {detail && <aside aria-label="Rincian pekerjaan" className="pss-template-panel">{detail}</aside>}
      </div>
    </main>
  );
}
