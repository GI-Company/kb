// Donation link — deliberately just a URL, not a payment integration.
// Points at whatever external donation page you set up (GitHub Sponsors,
// Ko-fi, Buy Me a Coffee, a Stripe Payment Link, PayPal.me, ...) — all of
// these are plain hosted checkout pages, so no server-side payment code is
// needed here at all. Settings.tsx's "Support Kernos" section only renders
// the button once this is set; leave it unset and that section just shows
// the explanation with no button, same "hide until configured" pattern as
// isSupabaseConfigured/isSupabaseAdminConfigured elsewhere in this project.

export const DONATE_URL = (import.meta.env.VITE_DONATE_URL as string | undefined)?.trim() || '';

export const isDonateConfigured = !!DONATE_URL;
