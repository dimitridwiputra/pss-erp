import type { ReactNode } from 'react';

export type PageHeaderProps = {
  /** A short uppercase context line above the title, e.g. the business date. */
  eyebrow?: ReactNode;
  title: string;
  description?: ReactNode;
  /** At most one primary action plus secondary ones (DESIGN_SYSTEM UX-02). */
  actions?: ReactNode;
};

/** The heading block every screen inside the app shell starts with. */
export function PageHeader({ eyebrow, title, description, actions }: PageHeaderProps) {
  return (
    <header className="pss-page-header">
      <div>
        {eyebrow && <p className="pss-page-eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p className="pss-page-description">{description}</p>}
      </div>
      {actions && <div className="pss-page-actions">{actions}</div>}
    </header>
  );
}

/** A titled surface for one block of a page: a table, a form, a chart. */
export function Panel({ title, description, actions, children, flush = false }: {
  title?: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean;
}) {
  return (
    <section className={`pss-panel${flush ? ' pss-panel-flush' : ''}`} aria-label={title}>
      {(title || actions) && (
        <div className="pss-panel-head">
          <div>
            {title && <h2>{title}</h2>}
            {description && <p>{description}</p>}
          </div>
          {actions && <div className="pss-panel-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
