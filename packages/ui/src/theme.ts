export type ThemePreference = 'system' | 'light' | 'dark';

export const THEME_STORAGE_KEY = 'pss-theme';

/**
 * Runs before first paint (the app inlines it in <head>) so a dark preference never flashes light.
 * Light is the default; dark applies when chosen, or when "follow the device" is chosen and the
 * device is dark. It is a plain string so a server layout can inline it.
 */
export const themeBootScript = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d){document.documentElement.dataset.theme='dark';}}catch(e){}})();`;
