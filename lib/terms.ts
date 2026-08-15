// Terms of Service acceptance tracking — required from both guest and
// signed-in users (see components/TermsGate.tsx, wired in from App.tsx
// right before the desktop renders, after login/guest-entry but before
// any app is usable). Versioned so a real revision to the terms can force
// re-acceptance by bumping TERMS_VERSION — a stored acceptance of an
// older version doesn't count as accepting the new one.

export const TERMS_VERSION = '1';
const STORAGE_KEY = `kernos_terms_accepted_v${TERMS_VERSION}`;

export function hasAcceptedTerms(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function recordTermsAcceptance(): void {
  try {
    localStorage.setItem(STORAGE_KEY, 'true');
  } catch {
    // best-effort — if storage is unavailable, the gate just shows again next load
  }
}
