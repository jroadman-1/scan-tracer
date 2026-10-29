export interface Settings {
  /** 'trackpad': swipe pans, pinch zooms. 'mouse': wheel zooms, middle-drag pans. */
  nav: 'trackpad' | 'mouse';
  /** Trackpad only: plain swipe orbits and Shift+swipe pans, instead of the reverse. */
  swapOrbitPan: boolean;
  projection: 'perspective' | 'ortho';
  theme: 'auto' | 'light' | 'dark';
  units: 'mm' | 'in';
}

const KEY = 'scan-tool.settings';
const DEFAULTS: Settings = { nav: 'trackpad', swapOrbitPan: false, projection: 'perspective', theme: 'auto', units: 'mm' };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    // Storage can be unavailable (private windows, blocked site data).
  }
  return { ...DEFAULTS };
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Settings just won't persist.
  }
}
