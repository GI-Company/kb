// Client half of the 15-min/day guest quota (see api/guest-usage.ts for the
// server side). Only ever started for guest sessions — App.tsx gates this
// on AppUser.isGuest.
//
// Two intervals: a 1s visual tick so the Taskbar countdown actually counts
// down smoothly, and a 20s heartbeat that reports elapsed time to the
// server and snaps the visible countdown to the server's authoritative
// number. The visible countdown starts immediately at the full 15:00 (no
// waiting on the first network round trip) and keeps ticking locally even
// if the server isn't configured yet (SUPABASE_SERVICE_ROLE_KEY unset) or a
// heartbeat fails — but `allowed` only ever becomes false when the server
// explicitly says so. Local ticking alone never forces a sign-out; a
// reload trivially resets it, so enforcement has to be server-side to mean
// anything.

const HEARTBEAT_MS = 20_000;
const TICK_MS = 1_000;

export const GUEST_DAILY_LIMIT_SECONDS = 15 * 60;

// Set by App.tsx right before it force-logs-out a guest whose daily quota
// ran out; read once and cleared by LoginScreen.tsx to show why they're
// back at the login screen.
export const GUEST_LIMIT_MESSAGE_KEY = 'kernos_guest_limit_message';

export interface GuestUsageState {
  remainingSeconds: number;
  limitSeconds: number;
  allowed: boolean;
}

interface HeartbeatResponse {
  usedSeconds: number;
  limitSeconds: number;
  remainingSeconds: number | null; // null = server not configured for this yet
  allowed: boolean;
  configured: boolean;
}

async function heartbeat(elapsedSeconds: number): Promise<HeartbeatResponse | null> {
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
 * Starts the guest countdown: ticks every second, reconciles with the
 * server every 20s. Returns a cleanup function to stop tracking (call on
 * sign-out or when leaving the desktop).
 */
export function startGuestUsageTracking(onUpdate: (state: GuestUsageState) => void): () => void {
  let cancelled = false;
  let remaining = GUEST_DAILY_LIMIT_SECONDS;
  let lastHeartbeatAt = Date.now();

  const emit = (allowed = true) => {
    onUpdate({ remainingSeconds: remaining, limitSeconds: GUEST_DAILY_LIMIT_SECONDS, allowed });
  };
  emit(); // show 15:00 immediately, don't wait on the network

  const tickInterval = setInterval(() => {
    if (cancelled || document.visibilityState !== 'visible') return; // don't bill/tick background time
    remaining = Math.max(0, remaining - 1);
    emit();
  }, TICK_MS);

  const beatInterval = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    const now = Date.now();
    const elapsed = Math.round((now - lastHeartbeatAt) / 1000);
    lastHeartbeatAt = now;
    heartbeat(elapsed).then(state => {
      if (!state || cancelled) return;
      if (state.remainingSeconds !== null) {
        remaining = state.remainingSeconds; // snap to the authoritative value
      }
      emit(state.allowed);
    });
  }, HEARTBEAT_MS);

  return () => {
    cancelled = true;
    clearInterval(tickInterval);
    clearInterval(beatInterval);
  };
}

export function formatRemaining(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
