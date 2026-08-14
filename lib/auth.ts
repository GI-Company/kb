// Auth — real Supabase accounts when configured, always with a local
// "guest" fallback so the app stays frictionless for anyone who doesn't
// want to sign up (same spirit as the original design's guest access,
// just now sitting next to a real option instead of being the only one).

import { User } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured } from './supabaseClient';

export interface AppUser {
  id: string;
  username: string;
  avatar_url: string;
  isGuest: boolean;
}

function toAppUser(user: User): AppUser {
  return {
    id: user.id,
    username: (user.user_metadata?.username as string) || user.email?.split('@')[0] || 'user',
    avatar_url: (user.user_metadata?.avatar_url as string) || '',
    isGuest: false,
  };
}

export async function getSession(): Promise<AppUser | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.user ? toAppUser(data.session.user) : null;
}

export async function signUp(email: string, password: string, username: string): Promise<AppUser> {
  if (!supabase) throw new Error('Accounts aren\'t configured on this deployment yet — continue as guest instead.');
  const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { username } } });
  if (error) throw error;
  // Supabase returns a `user` object either way — checking that alone was
  // the bug: with email confirmation on (this project's default), `user`
  // is set but `session` is null until the user clicks the confirmation
  // link, and treating that as "logged in" left the app showing the
  // desktop with no real session behind it (confirmed live: zero sb-*
  // key ever landed in localStorage). `session` is the actual signal.
  if (!data.session || !data.user) {
    throw new Error('Account created — check your email to confirm it, then sign in.');
  }
  return toAppUser(data.user);
}

export async function signIn(email: string, password: string): Promise<AppUser> {
  if (!supabase) throw new Error('Accounts aren\'t configured on this deployment yet — continue as guest instead.');
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  if (!data.user) throw new Error('Sign-in failed.');
  return toAppUser(data.user);
}

export async function signOut(): Promise<void> {
  if (supabase) await supabase.auth.signOut();
}

/** Resolves the current user id for scoping chat history / future per-user data — real session if one exists, else the locally-saved guest id, else the literal string "guest" as a last resort. Used by apps (AIChat.tsx) that need an id but don't otherwise track the full AppUser. */
export async function getCurrentUserId(): Promise<string> {
  const session = await getSession();
  if (session) return session.id;
  try {
    const saved = localStorage.getItem('kernos_guest_user');
    if (saved) return (JSON.parse(saved) as AppUser).id;
  } catch {
    // Corrupt saved session — fall through to the last-resort id.
  }
  return 'guest';
}

export function createGuestUser(): AppUser {
  const guestId = Math.random().toString(36).substring(2, 6);
  return {
    id: `guest-${guestId}`,
    username: `Guest_${guestId}`,
    avatar_url: `https://api.dicebear.com/7.x/identicon/svg?seed=${guestId}`,
    isGuest: true,
  };
}

export { isSupabaseConfigured };
