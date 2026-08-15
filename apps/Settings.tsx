import React, { useEffect, useState } from 'react';
import { useOS } from '../store';
import { getSession, signOut, AppUser } from '../lib/auth';
import { resetAnalyticsIdentity, setAnalyticsOptOut } from '../lib/analytics';
import { DONATE_URL, isDonateConfigured } from '../lib/donate';
import { DEFAULT_AGENTS } from '../lib/agents';
import { getSettings, setSetting, resetSettings, subscribeSettings, KernosSettings } from '../lib/settings';
import { Settings, Palette, Type, Bot, LogOut, UserCircle, Loader2, Zap, Compass, Heart, ExternalLink, Sun, Moon, RotateCcw, ShieldOff, PlaySquare } from 'lucide-react';

// Toggle switch — shared visual for every boolean preference below, matches
// the Lite Mode toggle this replaced/extended.
const Toggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void; title?: string }> = ({ checked, onChange, title }) => (
  <button
    onClick={() => onChange(!checked)}
    className={`shrink-0 relative rounded-full transition-colors ${checked ? 'bg-cyan-500' : 'bg-white/10'}`}
    style={{ width: 40, height: 22 }}
    title={title}
  >
    <span
      className="absolute top-0.5 left-0.5 rounded-full bg-white transition-transform"
      style={{ width: 18, height: 18, transform: checked ? 'translateX(18px)' : 'translateX(0)' }}
    />
  </button>
);

const Row: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div className="flex items-center justify-between gap-4 mb-3 last:mb-0">
    <div className="min-w-0">
      <div className="text-sm text-white">{label}</div>
      {hint && <div className="text-[11px] text-gray-500 leading-relaxed mt-0.5">{hint}</div>}
    </div>
    <div className="shrink-0">{children}</div>
  </div>
);

export const SettingsApp: React.FC = () => {
  const { liteMode, setLiteMode, openWalkthrough } = useOS();
  const [settings, setSettings] = useState<KernosSettings>(getSettings());
  const [sessionUser, setSessionUser] = useState<AppUser | null>(null);
  const [guestUser, setGuestUser] = useState<AppUser | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    getSession().then(setSessionUser);
    try {
      const saved = localStorage.getItem('kernos_guest_user');
      if (saved) setGuestUser(JSON.parse(saved));
    } catch { /* corrupt/unavailable storage — just skip the guest badge */ }
  }, []);

  // Any tab (or Settings.tsx itself) changing a setting updates this
  // panel's own display without a manual re-fetch — same pattern the old
  // sys.config:ack listener was trying to achieve, just actually wired.
  useEffect(() => subscribeSettings(setSettings), []);

  const update = <K extends keyof KernosSettings>(key: K, value: KernosSettings[K]) => {
    setSetting(key, value);
    if (key === 'analyticsOptOut') setAnalyticsOptOut(value as boolean);
  };

  const handleSignOut = async () => {
    setSigningOut(true);
    await signOut();
    resetAnalyticsIdentity();
    localStorage.removeItem('kernos_guest_user');
    window.location.reload();
  };

  return (
    <div className="h-full bg-[#0a0a0f] text-white p-5 overflow-y-auto">
      <div className="flex items-center gap-2 mb-6">
        <Settings className="text-gray-400" size={18} />
        <h2 className="text-sm font-bold uppercase tracking-widest text-gray-300">System Preferences</h2>
      </div>

      <div className="mb-6 p-4 rounded-lg bg-white/5 border border-white/5">
        <div className="flex items-center gap-2 mb-3">
          <UserCircle size={14} className="text-cyan-400" />
          <span className="text-xs font-mono text-gray-400 uppercase tracking-wider">Account</span>
        </div>
        {sessionUser ? (
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-white">{sessionUser.username}</div>
              <div className="text-[11px] text-gray-500">Signed in</div>
            </div>
            <button
              onClick={handleSignOut}
              disabled={signingOut}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-medium hover:bg-red-500/20 disabled:opacity-40 transition-colors"
            >
              {signingOut ? <Loader2 size={12} className="animate-spin" /> : <LogOut size={12} />}
              Sign Out
            </button>
          </div>
        ) : guestUser ? (
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-white">{guestUser.username}</div>
              <div className="text-[11px] text-gray-500">Guest session — data stays on this browser only</div>
            </div>
            <button
              onClick={handleSignOut}
              disabled={signingOut}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-medium hover:bg-red-500/20 disabled:opacity-40 transition-colors"
            >
              {signingOut ? <Loader2 size={12} className="animate-spin" /> : <LogOut size={12} />}
              Sign Out
            </button>
          </div>
        ) : (
          <div className="text-xs text-gray-500">
            Using a guest identity (chat history stays on this browser only). Reload and sign in from the login screen for an account that syncs across devices.
          </div>
        )}
      </div>

      <div className="mb-6 p-4 rounded-lg bg-white/5 border border-white/5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Zap size={14} className="text-yellow-400" />
            <span className="text-xs font-mono text-gray-400 uppercase tracking-wider">Preferences</span>
          </div>
          <button
            onClick={() => resetSettings()}
            className="flex items-center gap-1 text-[10px] text-gray-600 hover:text-gray-300 transition-colors"
            title="Reset all preferences below to defaults"
          >
            <RotateCcw size={10} /> Reset
          </button>
        </div>

        <Row label="Theme" hint="Applies to the desktop, taskbar, and window frames. Individual app panels stay dark for now.">
          <div className="flex gap-1 bg-black/40 rounded-lg p-1 border border-white/5">
            <button
              onClick={() => update('theme', 'dark')}
              className={`p-1.5 rounded flex items-center gap-1 text-[10px] transition-colors ${settings.theme === 'dark' ? 'bg-white/10 text-white' : 'text-gray-500'}`}
            >
              <Moon size={12} /> Dark
            </button>
            <button
              onClick={() => update('theme', 'light')}
              className={`p-1.5 rounded flex items-center gap-1 text-[10px] transition-colors ${settings.theme === 'light' ? 'bg-white/10 text-white' : 'text-gray-500'}`}
            >
              <Sun size={12} /> Light
            </button>
          </div>
        </Row>

        <div className="h-px bg-white/5 my-3" />

        <Row label="Lite Mode" hint="Skips the boot animation and window motion — faster on weaker devices, not fewer features.">
          <Toggle checked={liteMode} onChange={setLiteMode} title={liteMode ? 'Disable Lite Mode' : 'Enable Lite Mode'} />
        </Row>

        <div className="h-px bg-white/5 my-3" />

        <Row label="Show Boot Sequence" hint="Play the cinematic BIOS-style boot on next launch. Independent of Lite Mode.">
          <Toggle checked={settings.showBootSequence} onChange={v => update('showBootSequence', v)} />
        </Row>

        <div className="h-px bg-white/5 my-3" />

        <Row label="Reduce Motion" hint="Disables window open/close animation and other transitions app-wide.">
          <Toggle checked={settings.reduceMotion} onChange={v => update('reduceMotion', v)} />
        </Row>

        <div className="h-px bg-white/5 my-3" />

        <Row label="Interactive Walkthrough" hint="Replay the guided tour of the taskbar apps.">
          <button
            onClick={openWalkthrough}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 text-xs font-medium hover:bg-cyan-500/20 transition-colors"
          >
            <Compass size={12} />
            Take the Tour
          </button>
        </Row>
      </div>

      <div className="mb-6 p-4 rounded-lg bg-white/5 border border-white/5">
        <div className="flex items-center gap-2 mb-3">
          <Bot size={14} className="text-purple-400" />
          <span className="text-xs font-mono text-gray-400 uppercase tracking-wider">AI Chat</span>
        </div>

        <Row label="Default Agent" hint="Which persona AI Chat opens with. Leave as Auto to use the first agent in the roster.">
          <select
            value={settings.defaultPersona}
            onChange={e => update('defaultPersona', e.target.value)}
            className="bg-black/40 border border-white/10 rounded px-2 py-1.5 text-xs text-white outline-none focus:border-cyan-500/50"
          >
            <option value="">Auto</option>
            {DEFAULT_AGENTS.map(a => (
              <option key={a.id} value={a.id}>{a.displayName}</option>
            ))}
          </select>
        </Row>
      </div>

      <div className="mb-6 p-4 rounded-lg bg-white/5 border border-white/5">
        <div className="flex items-center gap-2 mb-3">
          <Type size={14} className="text-cyan-400" />
          <span className="text-xs font-mono text-gray-400 uppercase tracking-wider">Terminal</span>
        </div>

        <Row label="Font Size" hint="Applies to the Terminal app and CDE's integrated terminal panel.">
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={10}
              max={20}
              step={1}
              value={settings.terminalFontSize}
              onChange={e => update('terminalFontSize', Number(e.target.value))}
              className="w-28 accent-cyan-400"
            />
            <span className="text-xs font-mono text-gray-400 w-8 text-right">{settings.terminalFontSize}px</span>
          </div>
        </Row>
      </div>

      <div className="mb-6 p-4 rounded-lg bg-white/5 border border-white/5">
        <div className="flex items-center gap-2 mb-3">
          <PlaySquare size={14} className="text-orange-400" />
          <span className="text-xs font-mono text-gray-400 uppercase tracking-wider">Guest Access</span>
        </div>

        <Row label="Low-Time Warning" hint="Taskbar's countdown chip turns red once remaining daily guest time drops below this.">
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={30}
              max={300}
              step={30}
              value={settings.guestQuotaWarningSeconds}
              onChange={e => update('guestQuotaWarningSeconds', Number(e.target.value))}
              className="w-28 accent-orange-400"
            />
            <span className="text-xs font-mono text-gray-400 w-12 text-right">{Math.round(settings.guestQuotaWarningSeconds / 60 * 10) / 10}m</span>
          </div>
        </Row>
      </div>

      <div className="mb-6 p-4 rounded-lg bg-white/5 border border-white/5">
        <div className="flex items-center gap-2 mb-3">
          <ShieldOff size={14} className="text-red-400" />
          <span className="text-xs font-mono text-gray-400 uppercase tracking-wider">Privacy</span>
        </div>

        <Row label="Opt Out of Analytics" hint="Stops PostHog from receiving events from this browser, immediately. No effect if analytics isn't configured for this deployment.">
          <Toggle checked={settings.analyticsOptOut} onChange={v => update('analyticsOptOut', v)} />
        </Row>
      </div>

      <div className="mb-6 p-4 rounded-lg bg-white/5 border border-white/5">
        <div className="flex items-center gap-2 mb-3">
          <Palette size={14} className="text-pink-400" />
          <span className="text-xs font-mono text-gray-400 uppercase tracking-wider">Support Kernos</span>
        </div>
        <p className="text-[11px] text-gray-500 leading-relaxed mb-3">
          Kernos is an independently-funded project — Groq API calls, Supabase, and Vercel hosting all cost real money to run.
          Some capabilities are gated by hosting tier rather than code: the terminal's <span className="font-mono text-gray-400">render</span> command
          (real headless-browser page loads) needs a paid Vercel plan to get enough compute budget — Hobby's hard 10-second
          function limit isn't enough for a Chromium cold start plus a page load, no matter how it's configured. Donations go
          straight toward removing constraints like that for everyone using this.
        </p>
        {isDonateConfigured ? (
          <a
            href={DONATE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-pink-500/10 border border-pink-500/20 text-pink-400 text-xs font-medium hover:bg-pink-500/20 transition-colors"
          >
            <Heart size={12} />
            Support This Project
            <ExternalLink size={11} className="opacity-60" />
          </a>
        ) : (
          <div className="text-[10px] text-gray-600 italic">Donations aren't set up yet.</div>
        )}
      </div>
    </div>
  );
};
