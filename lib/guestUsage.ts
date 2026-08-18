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
  /**
   * True only until the very first heartbeat settles. The optimistic 15:00
   * this starts at is a display default, not a verified fact — a guest who
   * already used up today's quota in an earlier session shouldn't see a
   * confident countdown for however long that first round trip takes, even
   * though `allowed` itself never flips true->false incorrectly during
   * this window (the forced-logout in App.tsx only ever acts on an
   * explicit server response). This is what a caller checks before
   * trusting remainingSeconds enough to display it as fact.
   */
  checking: boolean;
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
    if (!res.ok) {
      // A deliberate refusal has to be honored, or the server's fail-closed
      // policy is cosmetic. api/guest-usage.ts returns 503 with
      // allowed:false when it cannot enforce the quota in production;
      // treating that like a network blip would silently grant the very
      // unmetered access it is refusing.
      const body = await res.json().catch(() => null);
      if (body && body.allowed === false) return body as HeartbeatResponse;
      return null;
    }
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
  let checking = true;
  let remaining = GUEST_DAILY_LIMIT_SECONDS;
  let lastHeartbeatAt = Date.now();

  const emit = (allowed = true) => {
    onUpdate({ remainingSeconds: remaining, limitSeconds: GUEST_DAILY_LIMIT_SECONDS, allowed, checking });
  };
  emit(); // show 15:00 immediately, don't wait on the network — checking:true says it's a placeholder, not a verified number

  // Ask the server where this guest actually stands, right now, rather than
  // waiting a full HEARTBEAT_MS. Without this the optimistic 15:00 is the
  // only thing anyone sees until the first heartbeat lands — so a guest who
  // is already over quota, or a deployment refusing guest access because it
  // can't enforce the quota, would see a confidently wrong countdown for
  // that whole window. elapsedSeconds 0 means "report, don't bill". Once
  // this settles — allowed, refused, or a genuine network failure — checking
  // drops to false either way: fail-open still applies to outages, this
  // only closes the gap where the UI *claimed* certainty it didn't have.
  heartbeat(0).then(state => {
    checking = false;
    if (!state || cancelled) { if (!cancelled) emit(); return; }
    if (state.remainingSeconds !== null) remaining = state.remainingSeconds;
    emit(state.allowed);
  });

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
