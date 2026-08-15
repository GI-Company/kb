// Client-side preferences store — replaces the old sys.config:get/set/ack
// kernel round-trip, which had no backend behind it (kernel.ts's router
// never answered `sys.config:*` with anything but a same-topic echo, so
// Settings.tsx's config panel could never actually populate). There is no
// remote config store in this architecture; these are real user prefs,
// backed by localStorage, applied directly to the DOM/app state that reads
// them below — not routed through the kernel bus at all.
//
// Each setting here maps to one concrete, already-existing piece of UI or
// behavior (see the call sites: App.tsx, Window.tsx, Taskbar.tsx,
// Terminal.tsx, CDE.tsx, AIChat.tsx, lib/analytics.ts). If a setting has no
// call site touching it, it doesn't belong here — that's exactly the
// "decorative panel" failure mode this replaces.

export interface KernosSettings {
  // Applies to the desktop background, taskbar, and window chrome (App.tsx,
  // Taskbar.tsx, Window.tsx) via CSS variables + a `data-theme` attribute.
  // Deliberately NOT claiming full light-mode coverage: individual app
  // panels (Terminal, AI Chat, CDE, ...) use hardcoded dark Tailwind
  // classes throughout and stay dark either way — retheming every app is a
  // separate, much larger pass, not silently promised here.
  theme: 'dark' | 'light';

  // Agent id (see lib/agents.ts) AI Chat opens with. Empty string = no
  // preference, falls back to the roster's first agent (current behavior).
  defaultPersona: string;

  // Seconds remaining in the guest daily quota below which Taskbar's
  // GuestUsageChip switches to its "low" (red) styling. UI-only, matches
  // what the chip already computes, just no longer hardcoded to 120.
  guestQuotaWarningSeconds: number;

  // Kills CSS transition/animation duration globally (a real, broad effect
  // via a global stylesheet rule) and switches Window.tsx's framer-motion
  // open/close animation to the same instant variant Lite Mode already
  // uses — independent of Lite Mode, which also skips the boot sequence
  // and is meant as a "faster overall" toggle, not specifically motion.
  reduceMotion: boolean;

  // px. Applied via a CSS variable Terminal.tsx and CDE's integrated
  // terminal panel both read instead of a hardcoded Tailwind text size.
  showBootSequence: boolean;

  // Skips CinematicBoot straight to session resolution, same mechanism
  // Lite Mode already uses in App.tsx — a separate toggle since Lite Mode
  // also affects window animation, and someone might want the boot skipped
  // without opting into every other Lite Mode change.
  terminalFontSize: number;

  // Calls posthog.opt_out_capturing()/opt_in_capturing() immediately (live,
  // no reload needed) in addition to gating lib/analytics.ts's
  // identifyUser/trackEvent calls. No effect if analytics was never
  // configured (VITE_POSTHOG_KEY unset) — nothing to opt out of.
  analyticsOptOut: boolean;
}

export const SETTINGS_DEFAULTS: KernosSettings = {
  theme: 'dark',
  defaultPersona: '',
  guestQuotaWarningSeconds: 120,
  reduceMotion: false,
  showBootSequence: true,
  terminalFontSize: 13,
  analyticsOptOut: false,
};

const STORAGE_KEY = 'kernos_settings';

type Listener = (settings: KernosSettings) => void;
const listeners = new Set<Listener>();

function readFromStorage(): KernosSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...SETTINGS_DEFAULTS };
    const parsed = JSON.parse(raw);
    return { ...SETTINGS_DEFAULTS, ...parsed };
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

function applyDocumentEffects(s: KernosSettings) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', s.theme);
  document.documentElement.style.setProperty('--kernos-terminal-font-size', `${s.terminalFontSize}px`);
  document.documentElement.classList.toggle('kernos-reduce-motion', s.reduceMotion);
}

let current = typeof window !== 'undefined' ? readFromStorage() : { ...SETTINGS_DEFAULTS };
applyDocumentEffects(current);

export function getSettings(): KernosSettings {
  return current;
}

export function getSetting<K extends keyof KernosSettings>(key: K): KernosSettings[K] {
  return current[key];
}

export function setSetting<K extends keyof KernosSettings>(key: K, value: KernosSettings[K]): void {
  current = { ...current, [key]: value };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* best-effort — settings just won't survive a reload */
  }
  applyDocumentEffects(current);
  listeners.forEach(l => l(current));
}

export function resetSettings(): void {
  current = { ...SETTINGS_DEFAULTS };
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* best-effort */ }
  applyDocumentEffects(current);
  listeners.forEach(l => l(current));
}

/** For components that need to re-render on any settings change (Settings.tsx itself, GuestUsageChip). Other call sites (App.tsx's boot check, AIChat's default persona) just read getSetting() once at the point they need it. */
export function subscribeSettings(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// Cross-tab sync — a settings change in one tab (e.g. toggling theme)
// updates every other open tab of the same origin without a reload.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return;
    current = readFromStorage();
    applyDocumentEffects(current);
    listeners.forEach(l => l(current));
  });
}
