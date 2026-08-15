// PostHog — product analytics. Wired up directly (posthog-js + init call)
// rather than via the official setup wizard: the wizard needs a real
// interactive terminal to run and has no working non-interactive/CI mode
// in its current published build, which doesn't exist in this environment.
// Same end result either way — this is exactly what the wizard would have
// generated for a Vite app.
//
// `initAnalytics` is a no-op when VITE_POSTHOG_KEY isn't set, same pattern
// as lib/supabaseClient.ts — analytics is optional, nothing else depends
// on it being configured.

import posthog from 'posthog-js';
import { getSetting } from './settings';

const apiKey = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const apiHost = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) || 'https://us.i.posthog.com';

export const isAnalyticsConfigured = !!apiKey;

export function initAnalytics(): void {
  if (!apiKey) {
    console.warn('[analytics] VITE_POSTHOG_KEY not set — analytics disabled.');
    return;
  }
  posthog.init(apiKey, {
    api_host: apiHost,
    person_profiles: 'identified_only', // don't create profiles for anonymous/guest usage
    capture_pageview: true,
    capture_pageleave: true,
    opt_out_capturing_by_default: getSetting('analyticsOptOut'),
  });
}

/** Settings.tsx's analytics opt-out toggle — flips PostHog's live capture state immediately, no reload needed. No-op if analytics was never configured. */
export function setAnalyticsOptOut(optOut: boolean): void {
  if (!apiKey) return;
  if (optOut) posthog.opt_out_capturing();
  else posthog.opt_in_capturing();
}

/** Associates subsequent events with a real (non-guest) account — called once after sign-in/sign-up. Guests stay anonymous by design (person_profiles: 'identified_only' above). */
export function identifyUser(userId: string, traits?: Record<string, unknown>): void {
  if (!apiKey || getSetting('analyticsOptOut')) return;
  posthog.identify(userId, traits);
}

export function resetAnalyticsIdentity(): void {
  if (!apiKey) return;
  posthog.reset();
}

export function trackEvent(name: string, properties?: Record<string, unknown>): void {
  if (!apiKey || getSetting('analyticsOptOut')) return;
  posthog.capture(name, properties);
}
