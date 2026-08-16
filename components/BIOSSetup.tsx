import React, { useState, useEffect } from 'react';
import {
  Cpu, Shield, Boxes, Info, RefreshCw, ArrowLeft, Loader2,
} from 'lucide-react';
import { getSession } from '../lib/auth';
import { isSupabaseConfigured } from '../lib/supabaseClient';
import { classifierRegistry, SavedClassifierMeta } from '../lib/classifierRegistry';
import { localModel } from '../lib/localModel';
import { SavedModelMeta } from '../lib/modelRegistry';
import { CAPABILITY_INFO, Capability } from '../lib/terminalCapabilities';

// ═══════════════════════════════════════════════════════════════
//  KERNOS BIOS — boot-time system diagnostics
//  Accessible during boot by right-clicking
// ═══════════════════════════════════════════════════════════════
//
// The previous version of this screen was a config editor for a system
// that no longer exists: an "LM Studio Endpoint" field (replaced by Groq),
// GitHub OAuth client id/secret (auth is Supabase now), an editable
// agents.yaml with "hot-reload" (lib/agents.ts is a compiled TS file, not
// a YAML the app rereads at runtime), and an allowlist you could add/remove
// commands from (api/exec.ts's ALLOWED_COMMANDS is a hardcoded const — the
// UI let you "add" a command that would still 126 the moment you tried it).
// Every one of those fields talked to `bios.*` kernel topics that
// services/kernel.ts's own routing comment says plainly have no backend in
// this version — so every save silently vanished and every read stayed
// permanently blank. A BIOS that lies about what it configures is worse
// than no BIOS.
//
// This version shows only things that are true right now, sourced from the
// same modules the rest of the app reads from — nothing routes through the
// bus, because there is nothing on the other end of it for any of this.

type BIOSTab = 'system' | 'capabilities' | 'models' | 'allowlist';

interface BIOSSetupProps {
  onExit: () => void;
}

export const BIOSSetup: React.FC<BIOSSetupProps> = ({ onExit }) => {
  const [activeTab, setActiveTab] = useState<BIOSTab>('system');

  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [classifiers, setClassifiers] = useState<SavedClassifierMeta[] | null>(null);
  const [models, setModels] = useState<SavedModelMeta[] | null>(null);

  const [allowlistText, setAllowlistText] = useState<string | null>(null);
  const [allowlistError, setAllowlistError] = useState('');
  const [allowlistLoading, setAllowlistLoading] = useState(false);

  useEffect(() => {
    getSession().then(s => setSignedIn(s !== null));
    classifierRegistry.list().then(setClassifiers).catch(() => setClassifiers([]));
    // localModel's registry list doesn't need a real user id to enumerate
    // what's in this browser's IndexedDB — 'guest' is a safe default that
    // matches what a guest session already passes everywhere else.
    localModel.listSaved('guest').then(setModels).catch(() => setModels([]));
  }, []);

  const fetchAllowlist = () => {
    setAllowlistLoading(true);
    setAllowlistError('');
    fetch('/api/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'help' }),
    })
      .then(res => res.json())
      .then(data => setAllowlistText(data.stdout || data.stderr || '(empty response)'))
      .catch(err => setAllowlistError(err?.message || 'Could not reach /api/exec'))
      .finally(() => setAllowlistLoading(false));
  };

  useEffect(() => {
    if (activeTab === 'allowlist' && allowlistText === null && !allowlistLoading) fetchAllowlist();
  }, [activeTab]);

  // ESC exits BIOS, same as before.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExit();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onExit]);

  const tabs: { id: BIOSTab; label: string; icon: React.ReactNode }[] = [
    { id: 'system', label: 'System', icon: <Info size={14} /> },
    { id: 'capabilities', label: 'Capabilities', icon: <Shield size={14} /> },
    { id: 'models', label: 'Local Models', icon: <Boxes size={14} /> },
    { id: 'allowlist', label: 'Sandboxed Exec', icon: <Cpu size={14} /> },
  ];

  const CAPABILITY_ORDER: Capability[] = ['vfs', 'vfs:write', 'model:local', 'model:cloud', 'python', 'net', 'exec'];

  return (
    <div className="h-screen w-screen bg-[#000810] text-white font-mono flex flex-col select-none overflow-hidden">
      {/* Header */}
      <div className="h-12 bg-[#001020] border-b border-cyan-900/30 flex items-center px-6 gap-4 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded bg-cyan-500/20 flex items-center justify-center">
            <Cpu size={16} className="text-cyan-400" />
          </div>
          <div>
            <div className="text-sm font-bold text-cyan-400 tracking-wider">KERNOS OE</div>
            <div className="text-[9px] text-gray-600">Boot Diagnostics — read-only, sourced live</div>
          </div>
        </div>
        <div className="flex-1" />
        <button
          onClick={onExit}
          className="flex items-center gap-2 px-3 py-1.5 rounded bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white text-xs transition-colors border border-white/5"
        >
          <ArrowLeft size={12} />
          Exit → Boot
        </button>
      </div>

      {/* Tab Bar */}
      <div className="h-10 bg-[#000c18] border-b border-cyan-900/20 flex items-center px-4 gap-1 shrink-0">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 text-xs rounded-t transition-colors ${
              activeTab === tab.id
                ? 'bg-[#001428] text-cyan-400 border border-cyan-900/30 border-b-transparent -mb-px'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {/* ── System ── */}
        {activeTab === 'system' && (
          <div className="max-w-2xl space-y-4">
            <div className="bg-cyan-500/5 border border-cyan-900/20 rounded-lg p-4 text-xs leading-relaxed text-gray-400">
              A browser-hosted operating environment: host-mediated services, worker
              sandboxes, small trained specialists, cloud for hard reasoning. The
              browser is the HAL; Kernos is the layer on top of it — bus, VFS,
              capabilities, agents.
            </div>

            <div className="bg-white/[0.02] border border-white/5 rounded-lg p-4">
              <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-3">This Session</div>
              <div className="grid grid-cols-2 gap-y-2 text-xs">
                <span className="text-gray-500">Account</span>
                <span className="text-cyan-300">{signedIn === null ? '…' : signedIn ? 'Signed in' : 'Guest'}</span>

                <span className="text-gray-500">Filesystem backend</span>
                <span className="text-cyan-300">
                  {signedIn ? 'Supabase (Postgres, synced across devices)' : 'IndexedDB / localStorage (this browser only)'}
                </span>

                <span className="text-gray-500">Supabase configured</span>
                <span className="text-cyan-300">{isSupabaseConfigured ? 'yes' : 'no — guest mode is permanent on this deployment'}</span>

                <span className="text-gray-500">Viewport</span>
                <span className="text-cyan-300">{window.innerWidth}×{window.innerHeight}</span>

                <span className="text-gray-500">Touch points</span>
                <span className="text-cyan-300">{navigator.maxTouchPoints ?? 0}</span>

                <span className="text-gray-500">User agent</span>
                <span className="text-cyan-300 text-[10px] break-all">{navigator.userAgent}</span>
              </div>
            </div>

            <div className="bg-white/[0.02] border border-white/5 rounded-lg p-4">
              <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-3">Explicitly Not Here</div>
              <ul className="text-xs text-gray-500 space-y-1 list-disc list-inside">
                <li>A giant in-tab LLM — local models are small, trained specialists (see Local Models)</li>
                <li>Semantic search over the classifier trunk — measured, rejected (see BUILTINS.md)</li>
                <li>Package installs in the Python runtime — off behind a flag pending a CSP decision</li>
                <li>A mutable command allowlist — the sandboxed exec list is a fixed const, shown read-only under Sandboxed Exec</li>
              </ul>
            </div>
          </div>
        )}

        {/* ── Capabilities ── */}
        {activeTab === 'capabilities' && (
          <div className="max-w-2xl">
            <h3 className="text-sm font-bold text-cyan-400 mb-1 uppercase tracking-wider">Capability Table</h3>
            <p className="text-[10px] text-gray-600 mb-4">
              What this session can do, and what gates it — the same table `can` and `policy` read in the terminal.
              Not a privilege level: a declared surface.
            </p>
            <div className="space-y-2">
              {CAPABILITY_ORDER.map(cap => {
                const info = CAPABILITY_INFO[cap];
                const locked = info.gatedBy === 'signed-in' && signedIn === false;
                return (
                  <div key={cap} className="bg-white/[0.02] border border-white/5 rounded-lg p-3 flex items-start justify-between gap-4">
                    <div>
                      <div className="text-xs font-bold text-gray-200">{cap}</div>
                      <div className="text-[10px] text-gray-500 mt-0.5">{info.description}</div>
                    </div>
                    <div className={`text-[10px] whitespace-nowrap px-2 py-1 rounded ${
                      locked ? 'bg-amber-500/10 text-amber-400' : 'bg-emerald-500/10 text-emerald-400'
                    }`}>
                      {info.gatedBy === 'none' ? 'always available'
                        : info.gatedBy === 'rate-limit' ? 'available, rate-limited'
                        : locked ? 'sign in to unlock' : 'available (signed in)'}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Local Models ── */}
        {activeTab === 'models' && (
          <div className="max-w-2xl space-y-6">
            <div>
              <h3 className="text-sm font-bold text-cyan-400 mb-3 uppercase tracking-wider">
                Saved Classifiers {classifiers && `(${classifiers.length})`}
              </h3>
              {classifiers === null ? (
                <div className="text-xs text-gray-600 flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Reading IndexedDB…</div>
              ) : classifiers.length === 0 ? (
                <div className="text-xs text-gray-600">None yet — train one in the Intent Classifier app.</div>
              ) : (
                <div className="space-y-1.5">
                  {classifiers.map(c => (
                    <div key={c.name} className="flex items-center justify-between px-3 py-2 bg-white/[0.02] border border-white/5 rounded text-xs">
                      <span className="text-gray-200 font-bold">{c.name}</span>
                      <span className="text-gray-500">
                        {c.labels.join(', ')} · {c.paramCount.toLocaleString()} params · {c.exampleCount} examples
                        {c.heldOutAccuracy !== undefined && ` · held-out ${(c.heldOutAccuracy * 100).toFixed(1)}%`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <h3 className="text-sm font-bold text-cyan-400 mb-3 uppercase tracking-wider">
                Saved Generative Models {models && `(${models.length})`}
              </h3>
              {models === null ? (
                <div className="text-xs text-gray-600 flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Reading IndexedDB…</div>
              ) : models.length === 0 ? (
                <div className="text-xs text-gray-600">None yet — train one in the Local Model app.</div>
              ) : (
                <div className="space-y-1.5">
                  {models.map(m => (
                    <div key={m.name} className="flex items-center justify-between px-3 py-2 bg-white/[0.02] border border-white/5 rounded text-xs">
                      <span className="text-gray-200 font-bold">{m.name}</span>
                      <span className="text-gray-500">{m.paramCount.toLocaleString()} params · vocab {m.vocabSize}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Sandboxed Exec allowlist ── */}
        {activeTab === 'allowlist' && (
          <div className="max-w-2xl">
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-sm font-bold text-cyan-400 uppercase tracking-wider">Sandboxed Exec</h3>
              <button
                onClick={fetchAllowlist}
                disabled={allowlistLoading}
                className="flex items-center gap-1.5 px-3 py-1 rounded bg-white/5 hover:bg-white/10 text-gray-400 text-[10px] transition-colors disabled:opacity-50"
              >
                <RefreshCw size={10} className={allowlistLoading ? 'animate-spin' : ''} /> Refetch
              </button>
            </div>
            <p className="text-[10px] text-gray-600 mb-4">
              Fetched live from /api/exec's own `help` response — the actual allowlist the
              server enforces, not a cached or editable copy. Every command here runs in a
              fresh, disposable jail per invocation and never touches your real files.
            </p>
            {allowlistLoading && !allowlistText && (
              <div className="text-xs text-gray-600 flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Fetching…</div>
            )}
            {allowlistError && (
              <div className="text-xs text-red-400 bg-red-500/5 border border-red-900/30 rounded p-3">{allowlistError}</div>
            )}
            {allowlistText && (
              <pre className="text-[11px] text-gray-300 bg-black/50 border border-white/10 rounded-lg p-4 whitespace-pre-wrap leading-5">
                {allowlistText}
              </pre>
            )}
          </div>
        )}
      </div>

      {/* Status Bar */}
      <div className="h-7 bg-[#001020] border-t border-cyan-900/20 flex items-center px-4 text-[10px] font-mono text-gray-600 shrink-0">
        <span className="flex items-center gap-1">
          <Cpu size={10} className="text-cyan-500" />
          Kernos OE
        </span>
        <div className="flex-1" />
        <span>Press ESC or click "Exit → Boot" to continue boot</span>
      </div>
    </div>
  );
};
