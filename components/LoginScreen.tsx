import React, { useState } from 'react';
import { signIn, signUp, createGuestUser, isSupabaseConfigured, AppUser } from '../lib/auth';
import { GUEST_LIMIT_MESSAGE_KEY } from '../lib/guestUsage';
import { User, Lock, Mail, Plus, LogIn, Loader2, Eye, EyeOff, Shield, Clock } from 'lucide-react';

function readAndClearGuestLimitMessage(): string {
  try {
    const msg = localStorage.getItem(GUEST_LIMIT_MESSAGE_KEY);
    if (msg) localStorage.removeItem(GUEST_LIMIT_MESSAGE_KEY);
    return msg || '';
  } catch {
    return '';
  }
}

interface LoginScreenProps {
  onLogin: (user: AppUser) => void;
  onGuestAccess: () => void;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onLogin, onGuestAccess }) => {
  const [isSignup, setIsSignup] = useState(false);
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [guestLimitMessage] = useState(readAndClearGuestLimitMessage);

  const handleSubmit = async () => {
    if (!email || !password) return;
    setLoading(true);
    setError('');
    try {
      const user = isSignup ? await signUp(email, password, username || email.split('@')[0]) : await signIn(email, password);
      onLogin(user);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-screen w-screen bg-gradient-to-br from-[#0a0a1a] via-[#0d1025] to-[#0a0a1a] flex items-center justify-center select-none overflow-hidden">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {Array.from({ length: 20 }).map((_, i) => (
          <div
            key={i}
            className="absolute rounded-full opacity-10"
            style={{
              width: `${Math.random() * 4 + 1}px`,
              height: `${Math.random() * 4 + 1}px`,
              background: `hsl(${200 + Math.random() * 60}, 80%, 70%)`,
              left: `${Math.random() * 100}%`,
              top: `${Math.random() * 100}%`,
              animation: `pulse ${3 + Math.random() * 4}s ease-in-out infinite`,
              animationDelay: `${Math.random() * 3}s`,
            }}
          />
        ))}
      </div>

      <div className="relative z-10 flex flex-col items-center gap-6 max-w-md w-full px-8">
        <div className="flex flex-col items-center gap-2 mb-4">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center shadow-lg shadow-cyan-500/20">
            <Shield size={32} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Kernos OS</h1>
          <p className="text-xs text-gray-500">Groq-Powered AI Workspace</p>
        </div>

        <div className="w-full bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl p-6 shadow-2xl">
          {!isSupabaseConfigured && (
            <div className="mb-4 text-xs text-amber-400 bg-amber-400/10 rounded-lg px-3 py-2">
              Accounts aren't configured on this deployment — continue as guest below.
            </div>
          )}

          {guestLimitMessage && (
            <div className="mb-4 flex items-start gap-2 text-xs text-amber-400 bg-amber-400/10 rounded-lg px-3 py-2">
              <Clock size={14} className="shrink-0 mt-0.5" />
              <span>{guestLimitMessage}</span>
            </div>
          )}

          <h2 className="text-sm font-bold text-white mb-1">{isSignup ? 'Create Your Account' : 'Sign In'}</h2>
          <p className="text-xs text-gray-500 mb-5">
            {isSignup ? 'Chat history syncs across devices once you create an account.' : 'Welcome back.'}
          </p>

          <div className="space-y-3">
            {isSignup && (
              <div className="relative">
                <User size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
                <input
                  type="text"
                  placeholder="Username (optional)"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  className="w-full bg-black/40 border border-white/10 rounded-lg pl-9 pr-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-cyan-500/50 transition-colors"
                />
              </div>
            )}
            <div className="relative">
              <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
              <input
                type="email"
                placeholder="Email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="w-full bg-black/40 border border-white/10 rounded-lg pl-9 pr-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-cyan-500/50 transition-colors"
                autoFocus
              />
            </div>
            <div className="relative">
              <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
              <input
                type={showPassword ? 'text' : 'password'}
                placeholder="Password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSubmit()}
                className="w-full bg-black/40 border border-white/10 rounded-lg pl-9 pr-10 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-cyan-500/50 transition-colors"
              />
              <button
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-600 hover:text-white"
              >
                {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          {error && (
            <div className="mt-3 text-xs text-red-400 bg-red-400/10 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <button
            onClick={handleSubmit}
            disabled={loading || !email || !password}
            className="w-full mt-4 py-2.5 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 text-white text-sm font-bold hover:from-cyan-400 hover:to-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : isSignup ? <Plus size={14} /> : <LogIn size={14} />}
            {isSignup ? 'Create Account' : 'Sign In'}
          </button>

          <div className="flex items-center justify-between mt-4">
            <button
              onClick={() => { setIsSignup(!isSignup); setError(''); }}
              className="text-xs text-gray-500 hover:text-white transition-colors"
            >
              {isSignup ? '← Back to sign in' : 'New Account'}
            </button>
            <button
              onClick={onGuestAccess}
              className="text-xs text-gray-600 hover:text-cyan-400 transition-colors"
            >
              Continue as Guest
            </button>
          </div>
        </div>

        <p className="text-[10px] text-gray-700 mt-4">Kernos + BNLM — Cloud reasoning, local execution.</p>
        <p className="text-[9px] text-gray-800 mt-1 tracking-wide">A GI-Company Product</p>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 0.05; transform: scale(1); }
          50% { opacity: 0.15; transform: scale(1.5); }
        }
      `}</style>
    </div>
  );
};
