import type { ReactNode } from 'react';

export type AdminConsoleTemplateProps = {
  /** Brand mark shown at the top of the sidebar — a logo plus product name, e.g. "PSS Gudang". */
  brand: ReactNode;
  /** Sidebar navigation links, built by the app (e.g. with next/link) so this package stays framework-agnostic. */
  nav: ReactNode;
  /** Footer slot under the nav — a warehouse selector, current user, sign-out, etc. */
  sidebarFooter?: ReactNode;
  /** Full-width row above the page header — global search, warehouse selector, notifications, current user. */
  topBar: ReactNode;
  breadcrumb?: ReactNode;
  title: string;
  description?: string;
  actions?: ReactNode;
  feedback?: ReactNode;
  children: ReactNode;
};

/**
 * Desktop "Web App" console shell: persistent sidebar navigation, a top bar, and a scrollable
 * content area. Distinct from the single-screen `pss-page-template` flows used by the mobile web
 * view — pages placed inside `children` should still use `pss-template-panel` for their own
 * content so both surfaces share one visual language.
 */
export function AdminConsoleTemplate({ brand, nav, sidebarFooter, topBar, breadcrumb, title, description, actions, feedback, children }: AdminConsoleTemplateProps) {
  return (
    <div className="pss-admin-shell">
      <aside className="pss-admin-sidebar" aria-label="Navigasi utama">
        <div className="pss-admin-brand">{brand}</div>
        <nav aria-label="Menu gudang">{nav}</nav>
        {sidebarFooter && <div className="pss-admin-sidebar-footer">{sidebarFooter}</div>}
      </aside>
      <div className="pss-admin-content">
        <div className="pss-admin-topbar">{topBar}</div>
        <div className="pss-admin-content-inner">
          <header className="pss-admin-content-header">
            {breadcrumb && <p className="pss-admin-breadcrumb">{breadcrumb}</p>}
            <div className="pss-admin-content-header-row">
              <div>
                <h1>{title}</h1>
                {description && <p className="pss-admin-description">{description}</p>}
              </div>
              {actions && <div className="pss-admin-content-actions">{actions}</div>}
            </div>
          </header>
          {feedback && <div className="pss-template-feedback" role="status">{feedback}</div>}
          <div className="pss-admin-content-body">{children}</div>
        </div>
      </div>
    </div>
  );
}
