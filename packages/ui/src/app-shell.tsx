'use client';

import { ChevronsLeft, ChevronsRight, Menu, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';

export type AppShellLinkProps = {
  href: string;
  className?: string;
  'aria-current'?: 'page';
  onClick?: () => void;
  children: ReactNode;
};

export type AppShellNavItem = { key: string; href: string; label: string; icon?: ReactNode; description?: string };
export type AppShellNavSection = { key: string; label: string | null; items: readonly AppShellNavItem[] };

export type AppShellProps = {
  /** Logo plus product name at the top of the sidebar. */
  brand: ReactNode;
  sections: readonly AppShellNavSection[];
  /** The current path, used to mark the active item (the app reads it from its router). */
  pathname: string;
  /** The app's link component (e.g. next/link), so this package stays framework-agnostic. */
  Link: ComponentType<AppShellLinkProps>;
  /** Navigates after a quick-jump choice; the app passes its router's push. */
  onNavigate: (href: string) => void;
  user: { name: string; detail?: string };
  /** Items in the account menu: theme choice, sign-out form. */
  userMenu: ReactNode;
  /** Right side of the top bar before the account button, e.g. a connection status. */
  topBarExtra?: ReactNode;
  children: ReactNode;
};

const COLLAPSE_KEY = 'pss-sidebar-collapsed';

function isActive(pathname: string, href: string, allHrefs: readonly string[]): boolean {
  if (pathname === href) return true;
  if (!pathname.startsWith(`${href}/`)) return false;
  // The longest matching item wins, so /kantor does not light up on /kantor/stok.
  return !allHrefs.some((other) => other !== href && other.startsWith(href) && (pathname === other || pathname.startsWith(`${other}/`)));
}

/**
 * The PSS web app frame (DESIGN_SYSTEM §6.1, §7.1): a collapsible sidebar grouped by work, a top
 * bar with quick-jump (Ctrl/⌘ K) and the account menu, and the page area. The app supplies only
 * the sections the viewer may open — a screen without permission is absent, never disabled (§7.2).
 */
export function AppShell({ brand, sections, pathname, Link, onNavigate, user, userMenu, topBarExtra, children }: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try { setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === '1'); } catch { /* storage blocked: stay expanded */ }
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPaletteOpen(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => { setDrawerOpen(false); setMenuOpen(false); }, [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    window.addEventListener('pointerdown', onPointer);
    return () => window.removeEventListener('pointerdown', onPointer);
  }, [menuOpen]);

  function toggleCollapsed() {
    setCollapsed((value) => {
      try { window.localStorage.setItem(COLLAPSE_KEY, value ? '0' : '1'); } catch { /* storage blocked: session-only */ }
      return !value;
    });
  }

  const allItems = useMemo(() => sections.flatMap((section) => section.items.map((item) => ({ ...item, section: section.label }))), [sections]);
  const hrefs = useMemo(() => allItems.map((item) => item.href), [allItems]);
  const current = allItems.find((item) => isActive(pathname, item.href, hrefs));

  return (
    <div className={`pss-app${collapsed ? ' pss-app-collapsed' : ''}${drawerOpen ? ' pss-app-drawer-open' : ''}`}>
      <aside className="pss-app-sidebar" aria-label="Navigasi utama">
        <div className="pss-app-brand">{brand}</div>
        <nav className="pss-app-nav" aria-label="Menu">
          {sections.map((section) => (
            <div className="pss-app-nav-section" key={section.key}>
              {section.label && <p className="pss-app-nav-heading">{section.label}</p>}
              {section.items.map((item) => {
                const active = isActive(pathname, item.href, hrefs);
                return (
                  <Link key={item.key} href={item.href} className={`pss-app-nav-link${active ? ' pss-app-nav-link-active' : ''}`}
                    {...(active ? { 'aria-current': 'page' as const } : {})}>
                    {item.icon && <span className="pss-app-nav-icon" aria-hidden="true">{item.icon}</span>}
                    <span className="pss-app-nav-label">{item.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <button type="button" className="pss-app-collapse" onClick={toggleCollapsed} aria-pressed={collapsed}
          aria-label={collapsed ? 'Lebarkan menu' : 'Ciutkan menu'} title={collapsed ? 'Lebarkan menu' : 'Ciutkan menu'}>
          {collapsed ? <ChevronsRight size={18} aria-hidden="true" /> : <ChevronsLeft size={18} aria-hidden="true" />}<span className="pss-app-nav-label">Ciutkan menu</span>
        </button>
      </aside>
      <button type="button" className="pss-app-scrim" aria-label="Tutup menu" tabIndex={drawerOpen ? 0 : -1} onClick={() => setDrawerOpen(false)} />

      <div className="pss-app-body">
        <header className="pss-app-topbar">
          <button type="button" className="pss-app-icon-button pss-app-menu-button" aria-label="Buka menu" onClick={() => setDrawerOpen(true)}>
            <Menu size={20} aria-hidden="true" />
          </button>
          <p className="pss-app-crumb">
            {current?.section && <><span>{current.section}</span><span aria-hidden="true"> / </span></>}
            <strong>{current?.label ?? 'PSS'}</strong>
          </p>
          <button type="button" className="pss-app-search" onClick={() => setPaletteOpen(true)}>
            <Search size={16} aria-hidden="true" /><span>Cari menu…</span><kbd>Ctrl K</kbd>
          </button>
          <div className="pss-app-topbar-end">
            {topBarExtra}
            <div className="pss-app-account" ref={menuRef}>
              <button type="button" className="pss-app-account-button" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
                <span className="pss-app-avatar" aria-hidden="true">{initials(user.name)}</span>
                <span className="pss-app-account-name"><strong>{user.name}</strong>{user.detail && <small>{user.detail}</small>}</span>
              </button>
              {menuOpen && <div className="pss-app-account-menu" role="menu">{userMenu}</div>}
            </div>
          </div>
        </header>
        <main className="pss-app-main" id="main">{children}</main>
      </div>

      {paletteOpen && <QuickJump items={allItems} onClose={() => setPaletteOpen(false)} onChoose={(href) => { setPaletteOpen(false); onNavigate(href); }} />}
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1]?.[0] ?? '' : '')).toUpperCase() || '?';
}

type QuickJumpItem = AppShellNavItem & { section: string | null };

/** Ctrl/⌘ K: type part of a screen's name, arrows to move, Enter to open, Esc to close. */
function QuickJump({ items, onClose, onChoose }: { items: readonly QuickJumpItem[]; onClose: () => void; onChoose: (href: string) => void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const term = query.trim().toLowerCase();
  const matches = term
    ? items.filter((item) => `${item.label} ${item.section ?? ''} ${item.description ?? ''}`.toLowerCase().includes(term))
    : items;

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setIndex(0); }, [term]);

  return (
    <div className="pss-quickjump-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="pss-quickjump" role="dialog" aria-modal="true" aria-label="Cari menu">
        <input ref={inputRef} className="pss-quickjump-input" value={query} placeholder="Ketik nama layar, mis. Setoran Kas" aria-label="Cari menu"
          aria-controls="pss-quickjump-list" aria-activedescendant={matches[index] ? `pss-qj-${matches[index].key}` : undefined}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose();
            if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((value) => Math.min(value + 1, Math.max(matches.length - 1, 0))); }
            if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((value) => Math.max(value - 1, 0)); }
            if (event.key === 'Enter' && matches[index]) onChoose(matches[index].href);
          }} />
        <ul className="pss-quickjump-list" id="pss-quickjump-list" role="listbox" aria-label="Hasil">
          {matches.length === 0 && <li className="pss-quickjump-empty">Tidak ada layar dengan nama itu.</li>}
          {matches.map((item, position) => (
            <li key={item.key} id={`pss-qj-${item.key}`} role="option" aria-selected={position === index}
              className={position === index ? 'pss-quickjump-active' : undefined}
              onPointerEnter={() => setIndex(position)} onClick={() => onChoose(item.href)}>
              {item.icon && <span className="pss-app-nav-icon" aria-hidden="true">{item.icon}</span>}
              <span><strong>{item.label}</strong>{item.description && <small>{item.description}</small>}</span>
              {item.section && <em>{item.section}</em>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
