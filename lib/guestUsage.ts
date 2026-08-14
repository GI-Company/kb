// Client half of the 15-min/day guest quota (see api/guest-usage.ts for the
// server side). Only ever started for guest sessions — App.tsx gates this
// on AppUser.isGuest.

const HEARTBEAT_MS = 20_000;

// Set by App.tsx right before it force-logs-out a guest whose daily quota
// ran out; read once and cleared by LoginScreen.tsx to show why they're
// back at the login screen.
export const GUEST_LIMIT_MESSAGE_KEY = 'kernos_guest_limit_message';

export interface GuestUsageState {
  usedSeconds: number;
  remainingSeconds: number | null; // null = unconfigured server-side, treat as unlimited
  limitSeconds: number;
  allowed: boolean;
}

async function heartbeat(elapsedSeconds: number): Promise<GuestUsageState | null> {
  try {
    const res = await fetch('/api/guest-usage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elapsedSeconds }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // network hiccup — the next tick will just try again
  }
}

/**
 * Starts periodic usage heartbeats for the current guest session. Time only
 * accrues while the tab is visible, so an idle background tab doesn't burn
 * the quota. Returns a cleanup function to stop tracking (call on sign-out
 * or when leaving the desktop).
 */
export function startGuestUsageTracking(onUpdate: (state: GuestUsageState) => void): () => void {
  let lastTick = Date.now();
  let cancelled = false;

  // Immediate 0-elapsed check so the UI has a real number right away
  // instead of waiting a full heartbeat interval.
  heartbeat(0).then(state => { if (state && !cancelled) onUpdate(state); });

  const interval = setInterval(() => {
    const now = Date.now();
    const elapsed = Math.round((now - lastTick) / 1000);
    lastTick = now;
    if (document.visibilityState !== 'visible') return; // don't bill background time
    heartbeat(elapsed).then(state => { if (state && !cancelled) onUpdate(state); });
  }, HEARTBEAT_MS);

  return () => {
    cancelled = true;
    clearInterval(interval);
  };
}

export function formatRemaining(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
