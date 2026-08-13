import React, { useEffect, useState } from 'react';
import { kernel } from '../services/kernel';
import { Envelope } from '../types';
import { Settings, Save, Undo2, Palette, Type, Globe, Cpu } from 'lucide-react';

interface ConfigEntry {
  key: string;
  value: string;
  label: string;
  icon: React.ReactNode;
}

const DEFAULT_CONFIGS: Omit<ConfigEntry, 'value'>[] = [
  { key: 'theme', label: 'Theme', icon: <Palette size={14} className="text-purple-400" /> },
  { key: 'font_size', label: 'Font Size', icon: <Type size={14} className="text-cyan-400" /> },
  { key: 'lm_endpoint', label: 'LM Studio URL', icon: <Globe size={14} className="text-green-400" /> },
  { key: 'ai_model', label: 'AI Model', icon: <Cpu size={14} className="text-orange-400" /> },
];

export const SettingsApp: React.FC = () => {
  const [configs, setConfigs] = useState<ConfigEntry[]>([]);
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);

  // Fetch current values on mount
  useEffect(() => {
    DEFAULT_CONFIGS.forEach(cfg => {
      kernel.publish('sys.config:get', { key: cfg.key });
    });

    const unsubscribe = kernel.subscribe((env: Envelope) => {
      if (env.topic === 'sys.config:ack') {
        const { key, value } = env.payload as { key: string; value: string };
        setConfigs(prev => {
          const existing = prev.find(c => c.key === key);
          const meta = DEFAULT_CONFIGS.find(d => d.key === key);
          if (existing) {
            return prev.map(c => c.key === key ? { ...c, value } : c);
          }
          return [...prev, { key, value: value || '', label: meta?.label || key, icon: meta?.icon || null }];
        });
      }
    });
    return unsubscribe;
  }, []);

  const handleSave = (key: string, value: string) => {
    setSaving(true);
    kernel.publish('sys.config:set', { key, value });
    setConfigs(prev => prev.map(c => c.key === key ? { ...c, value } : c));
    setEditKey(null);
    
    kernel.publish('sys.notify', { title: 'Settings', message: `Updated "${key}" successfully.`, urgency: 'success' });
    setTimeout(() => setSaving(false), 500);
  };

  const handleUndo = (key: string) => {
    kernel.publish('sys.undo:trigger', { category: 'sys.config', target: key });
    // Re-fetch after undo
    setTimeout(() => {
      kernel.publish('sys.config:get', { key });
    }, 300);
  };

  return (
    <div className="h-full bg-[#0a0a0f] text-white p-5 overflow-y-auto">
      <div className="flex items-center gap-2 mb-6">
        <Settings className="text-gray-400" size={18} />
        <h2 className="text-sm font-bold uppercase tracking-widest text-gray-300">System Preferences</h2>
      </div>

      <div className="space-y-3">
        {configs.map(cfg => (
          <div key={cfg.key} className="p-4 rounded-lg bg-white/5 border border-white/5 hover:border-white/10 transition-colors">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                {cfg.icon}
                <span className="text-xs font-mono text-gray-400 uppercase tracking-wider">{cfg.label}</span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => handleUndo(cfg.key)}
                  className="p-1.5 rounded hover:bg-white/10 text-gray-500 hover:text-yellow-400 transition-colors"
                  title="Undo last change"
                >
                  <Undo2 size={14} />
                </button>
              </div>
            </div>
            
            {editKey === cfg.key ? (
              <div className="flex gap-2">
                <input
                  type="text"
                  value={editValue}
                  onChange={e => setEditValue(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSave(cfg.key, editValue)}
                  className="flex-1 bg-black/50 border border-white/10 rounded px-3 py-1.5 text-sm font-mono text-white outline-none focus:border-cyan-500/50"
                  autoFocus
                />
                <button
                  onClick={() => handleSave(cfg.key, editValue)}
                  className="px-3 py-1.5 rounded bg-cyan-500/20 text-cyan-400 text-xs font-bold hover:bg-cyan-500/30 transition-colors flex items-center gap-1"
                >
                  <Save size={12} /> Save
                </button>
              </div>
            ) : (
              <div
                onClick={() => { setEditKey(cfg.key); setEditValue(cfg.value); }}
                className="text-sm font-mono text-white/80 cursor-pointer hover:text-white px-3 py-1.5 rounded bg-black/30 border border-transparent hover:border-white/10 transition-all"
              >
                {cfg.value || <span className="text-gray-600 italic">not set</span>}
              </div>
            )}
          </div>
        ))}
      </div>

      {configs.length === 0 && (
        <div className="text-center text-gray-600 mt-10">
          <Settings className="mx-auto mb-3 opacity-30" size={32} />
          <p className="text-sm">Connecting to kernel...</p>
        </div>
      )}
    </div>
  );
};
