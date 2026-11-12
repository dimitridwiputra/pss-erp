'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { THEME_STORAGE_KEY, type ThemePreference } from './theme';

function prefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyTheme(preference: ThemePreference) {
  const dark = preference === 'dark' || (preference === 'system' && prefersDark());
  if (dark) document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
  try { window.localStorage.setItem(THEME_STORAGE_KEY, preference); } catch { /* storage blocked: applies to this page only */ }
}

const choices = [
  { value: 'light', label: 'Terang', Icon: Sun },
  { value: 'dark', label: 'Gelap', Icon: Moon },
  { value: 'system', label: 'Ikuti perangkat', Icon: Monitor },
] as const;

/** Light (default), dark, or follow the device, for the account menu. */
export function ThemeChoice() {
  const [preference, setPreference] = useState<ThemePreference>('light');
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (stored === 'dark' || stored === 'system') setPreference(stored);
    } catch { /* storage blocked: light */ }
  }, []);
  useEffect(() => {
    if (preference !== 'system') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const follow = () => applyTheme('system');
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, [preference]);

  return (
    <fieldset className="pss-theme-choice">
      <legend>Tampilan</legend>
      <div>
        {choices.map(({ value, label, Icon }) => (
          <button key={value} type="button" role="menuitemradio" aria-checked={preference === value}
            className={preference === value ? 'pss-theme-active' : undefined}
            onClick={() => { setPreference(value); applyTheme(value); }}>
            <Icon size={16} aria-hidden="true" />{label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
