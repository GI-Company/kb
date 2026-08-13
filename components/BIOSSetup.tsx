import React, { useState, useEffect } from 'react';
import { kernel } from '../services/kernel';
import { Envelope } from '../types';
import {
  Settings, Cpu, Shield, Terminal, Box, Save, Plus, Trash2,
  RefreshCw, Download, CheckCircle, AlertTriangle, Loader2, ArrowLeft
} from 'lucide-react';

// ═══════════════════════════════════════════════════════════════
//  KERNOS BIOS SETUP — System Configuration Utility
//  Accessible during boot by pressing F2/DEL
// ═══════════════════════════════════════════════════════════════

type BIOSTab = 'system' | 'allowlist' | 'agents' | 'firmware';

interface BIOSSetupProps {
  onExit: () => void;
}

export const BIOSSetup: React.FC<BIOSSetupProps> = ({ onExit }) => {
  const [activeTab, setActiveTab] = useState<BIOSTab>('system');

  // System config
  const [sysConfig, setSysConfig] = useState<Record<string, string>>({});
  const [sysInfo, setSysInfo] = useState<Record<string, any>>({});
  const [configSaving, setConfigSaving] = useState(false);

  // Allowlist
  const [commands, setCommands] = useState<string[]>([]);
  const [newCommand, setNewCommand] = useState('');

  // Agents YAML
  const [agentsYaml, setAgentsYaml] = useState('');
  const [agentsSaving, setAgentsSaving] = useState(false);
  const [agentsMessage, setAgentsMessage] = useState('');

  // Firmware
  const [firmware, setFirmware] = useState<Record<string, any>>({});
  const [firmwareSnapshot, setFirmwareSnapshot] = useState('');

  // Status messages
  const [statusMsg, setStatusMsg] = useState('');

  // Connection status
  const [connected, setConnected] = useState(false);

  // ── Wait for WebSocket → then load all BIOS data ──
  useEffect(() => {
    const fetchAll = () => {
      kernel.publish('bios.sysconfig:read', {});
      kernel.publish('bios.sysinfo', {});
      kernel.publish('bios.allowlist:read', {});
      kernel.publish('bios.agents:read', {});
      kernel.publish('bios.firmware:check', {});
    };

    // Poll until the kernel WS is live
    const pollId = setInterval(() => {
      if (kernel.isLive) {
        setConnected(true);
        fetchAll();
        clearInterval(pollId);
      }
    }, 500);

    // If already live, fetch immediately
    if (kernel.isLive) {
      setConnected(true);
      fetchAll();
      clearInterval(pollId);
    }

    // Also listen for system.connect event in case it connects mid-poll
    const unsub = kernel.subscribe((env: Envelope) => {
      if (env.topic === 'system.connect') {
        setConnected(true);
        setTimeout(fetchAll, 300); // Brief delay for auth handshake
      }

      const p = env.payload as any;

      if (env.topic === 'bios.sysconfig:resp' && !p?.success) {
        setSysConfig(p || {});
      }
      if (env.topic === 'bios.sysconfig:resp' && p?.success) {
        setConfigSaving(false);
        showStatus('✅ Configuration saved');
      }
      if (env.topic === 'bios.sysinfo:resp') {
        setSysInfo(p || {});
      }
      if (env.topic === 'bios.allowlist:resp') {
        if (p?.commands) {
          setCommands(p.commands);
        }
        if (p?.success) {
          kernel.publish('bios.allowlist:read', {});
          showStatus(p.action === 'added' ? `✅ Added: ${p.command}` : `❌ Removed: ${p.command}`);
        }
      }
      if (env.topic === 'bios.agents:resp') {
        if (p?.content) {
          setAgentsYaml(p.content);
        }
        if (p?.success) {
          setAgentsSaving(false);
          setAgentsMessage(p.message || 'Saved');
          showStatus('✅ agents.yaml saved — hot-reload triggered');
        }
        if (p?.error) {
          setAgentsSaving(false);
          setAgentsMessage('❌ ' + p.error);
        }
      }
      if (env.topic === 'bios.firmware:resp') {
        if (p?.type === 'export') {
          setFirmwareSnapshot(p.snapshot);
        } else {
          setFirmware(p || {});
        }
      }
    });

    return () => {
      clearInterval(pollId);
      unsub();
    };
  }, []);

  // ESC key exits BIOS
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExit();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onExit]);

  const showStatus = (msg: string) => {
    setStatusMsg(msg);
    setTimeout(() => setStatusMsg(''), 3000);
  };

  const handleSaveConfig = (key: string, value: string) => {
    setConfigSaving(true);
    kernel.publish('bios.sysconfig:set', { key, value });
    setSysConfig(prev => ({ ...prev, [key]: value }));
  };

  const handleAddCommand = () => {
    if (!newCommand.trim()) return;
    kernel.publish('bios.allowlist:add', { command: newCommand.trim() });
    setNewCommand('');
  };

  const handleRemoveCommand = (cmd: string) => {
    kernel.publish('bios.allowlist:remove', { command: cmd });
  };

  const handleSaveAgents = () => {
    setAgentsSaving(true);
    setAgentsMessage('');
    kernel.publish('bios.agents:write', { content: agentsYaml });
  };

  const handleExportFirmware = () => {
    kernel.publish('bios.firmware:export', {});
  };

  const tabs: { id: BIOSTab; label: string; icon: React.ReactNode }[] = [
    { id: 'system', label: 'System Config', icon: <Settings size={14} /> },
    { id: 'allowlist', label: 'Command Allowlist', icon: <Shield size={14} /> },
    { id: 'agents', label: 'AI Agents', icon: <Cpu size={14} /> },
    { id: 'firmware', label: 'Firmware', icon: <Box size={14} /> },
  ];

  const configFields = [
    { key: 'root_path', label: 'Root Filesystem Path', desc: 'Base path for VFS operations' },
    { key: 'lm_endpoint', label: 'LM Studio Endpoint', desc: 'URL for the local LLM API' },
    { key: 'ai_model', label: 'Default AI Model', desc: 'Model ID for all agents' },
    { key: 'theme', label: 'UI Theme', desc: 'dark, light, or custom' },
    { key: 'font_size', label: 'Font Size', desc: 'Base font size in pixels' },
    { key: 'github_client_id', label: 'GitHub OAuth Client ID', desc: 'For OAuth authentication' },
    { key: 'github_client_secret', label: 'GitHub OAuth Secret', desc: 'OAuth client secret' },
  ];

  // ═══════════════════════════════════════════════════
  //  RENDER
  // ═══════════════════════════════════════════════════

  return (
    <div className="h-screen w-screen bg-[#000810] text-white font-mono flex flex-col select-none overflow-hidden">
      {/* Header */}
      <div className="h-12 bg-[#001020] border-b border-cyan-900/30 flex items-center px-6 gap-4 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded bg-cyan-500/20 flex items-center justify-center">
            <Cpu size={16} className="text-cyan-400" />
          </div>
          <div>
            <div className="text-sm font-bold text-cyan-400 tracking-wider">KERNOS BIOS SETUP</div>
            <div className="text-[9px] text-gray-600">System Configuration Utility v1.0</div>
          </div>
        </div>
        <div className="flex-1" />
        <button
          onClick={onExit}
          className="flex items-center gap-2 px-3 py-1.5 rounded bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white text-xs transition-colors border border-white/5"
        >
          <ArrowLeft size={12} />
          Exit BIOS → Boot
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
        {/* ── System Config Tab ── */}
        {activeTab === 'system' && (
          <div className="max-w-2xl">
            <h3 className="text-sm font-bold text-cyan-400 mb-4 uppercase tracking-wider">System Configuration</h3>

            {/* System Info Box */}
            <div className="bg-cyan-500/5 border border-cyan-900/20 rounded-lg p-4 mb-6">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div><span className="text-gray-500">Version:</span> <span className="text-cyan-300">{sysInfo.version || '—'}</span></div>
                <div><span className="text-gray-500">Agents:</span> <span className="text-cyan-300">{sysInfo.agents_loaded || '—'}</span></div>
                <div><span className="text-gray-500">Allowlist:</span> <span className="text-cyan-300">{sysInfo.allowlist_size || '—'} commands</span></div>
                <div><span className="text-gray-500">Users:</span> <span className="text-cyan-300">{sysInfo.user_count || '0'}</span></div>
                <div><span className="text-gray-500">Vector Chunks:</span> <span className="text-cyan-300">{sysInfo.vector_chunks || '—'}</span></div>
                <div><span className="text-gray-500">Data Dir:</span> <span className="text-cyan-300 text-[10px]">{sysInfo.data_dir || '—'}</span></div>
              </div>
            </div>

            {/* Config Fields */}
            <div className="space-y-3">
              {configFields.map(field => (
                <div key={field.key} className="bg-white/[0.02] border border-white/5 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] text-gray-400 font-bold uppercase tracking-wider">{field.label}</span>
                    <span className="text-[9px] text-gray-700">{field.desc}</span>
                  </div>
                  <input
                    type={field.key.includes('secret') ? 'password' : 'text'}
                    value={sysConfig[field.key] || ''}
                    onChange={e => setSysConfig(prev => ({ ...prev, [field.key]: e.target.value }))}
                    onBlur={e => {
                      if (e.target.value !== '') handleSaveConfig(field.key, e.target.value);
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleSaveConfig(field.key, sysConfig[field.key] || '');
                    }}
                    className="w-full bg-black/50 border border-white/10 rounded px-3 py-1.5 text-xs text-white outline-none focus:border-cyan-500/50 transition-colors"
                    placeholder={`Enter ${field.label.toLowerCase()}...`}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Allowlist Tab ── */}
        {activeTab === 'allowlist' && (
          <div className="max-w-2xl">
            <h3 className="text-sm font-bold text-cyan-400 mb-4 uppercase tracking-wider">
              Command Allowlist ({commands.length} commands)
            </h3>

            {/* Add command */}
            <div className="flex gap-2 mb-4">
              <input
                type="text"
                value={newCommand}
                onChange={e => setNewCommand(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddCommand()}
                className="flex-1 bg-black/50 border border-white/10 rounded px-3 py-2 text-xs text-white outline-none focus:border-cyan-500/50"
                placeholder="Add a command (e.g. docker, kubectl, terraform)..."
              />
              <button
                onClick={handleAddCommand}
                className="px-4 py-2 rounded bg-cyan-500/20 text-cyan-400 text-xs font-bold hover:bg-cyan-500/30 transition-colors flex items-center gap-1"
              >
                <Plus size={12} /> Add
              </button>
            </div>

            {/* Command grid */}
            <div className="grid grid-cols-4 gap-1.5">
              {commands.map(cmd => (
                <div
                  key={cmd}
                  className="flex items-center justify-between px-2.5 py-1.5 bg-white/[0.03] border border-white/5 rounded text-xs group hover:border-red-500/30 transition-colors"
                >
                  <span className="text-gray-300 font-mono">{cmd}</span>
                  <button
                    onClick={() => handleRemoveCommand(cmd)}
                    className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 transition-all"
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Agents YAML Tab ── */}
        {activeTab === 'agents' && (
          <div className="max-w-3xl h-full flex flex-col">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-cyan-400 uppercase tracking-wider">
                AI Agent Configuration (agents.yaml)
              </h3>
              <div className="flex items-center gap-2">
                {agentsMessage && (
                  <span className="text-[10px] text-green-400">{agentsMessage}</span>
                )}
                <button
                  onClick={handleSaveAgents}
                  disabled={agentsSaving}
                  className="px-4 py-1.5 rounded bg-cyan-500/20 text-cyan-400 text-xs font-bold hover:bg-cyan-500/30 disabled:opacity-50 transition-colors flex items-center gap-1"
                >
                  {agentsSaving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                  Save & Hot-Reload
                </button>
              </div>
            </div>
            <div className="text-[10px] text-gray-600 mb-2">
              Editing this file will automatically hot-reload all AI agents (3s debounce)
            </div>
            <textarea
              value={agentsYaml}
              onChange={e => setAgentsYaml(e.target.value)}
              className="flex-1 min-h-[400px] bg-black/50 border border-white/10 rounded-lg p-4 text-xs text-gray-300 font-mono outline-none focus:border-cyan-500/30 resize-none leading-5"
              spellCheck={false}
            />
          </div>
        )}

        {/* ── Firmware Tab ── */}
        {activeTab === 'firmware' && (
          <div className="max-w-2xl">
            <h3 className="text-sm font-bold text-cyan-400 mb-4 uppercase tracking-wider">Firmware & Updates</h3>

            {/* Current version */}
            <div className="bg-white/[0.02] border border-white/5 rounded-lg p-4 mb-4">
              <div className="flex items-center gap-3 mb-3">
                {firmware.up_to_date ? (
                  <CheckCircle size={20} className="text-green-400" />
                ) : (
                  <AlertTriangle size={20} className="text-amber-400" />
                )}
                <div>
                  <div className="text-sm font-bold text-white">
                    {firmware.up_to_date ? 'System is up to date' : 'Update available'}
                  </div>
                  <div className="text-[10px] text-gray-500">
                    Current: v{firmware.current_version || '—'} • Latest: v{firmware.latest_version || '—'}
                  </div>
                </div>
              </div>
              {firmware.changelog && (
                <div className="text-xs text-gray-400 bg-black/30 rounded p-3 mt-2">
                  <span className="text-[10px] text-gray-600 uppercase tracking-wider">Changelog:</span>
                  <div className="mt-1">{firmware.changelog}</div>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="flex gap-3 mb-4">
              <button
                onClick={() => kernel.publish('bios.firmware:check', {})}
                className="px-4 py-2 rounded bg-white/5 hover:bg-white/10 text-gray-400 text-xs transition-colors flex items-center gap-2 border border-white/5"
              >
                <RefreshCw size={12} /> Check for Updates
              </button>
              <button
                onClick={handleExportFirmware}
                className="px-4 py-2 rounded bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 text-xs transition-colors flex items-center gap-2 border border-cyan-900/20"
              >
                <Download size={12} /> Export Firmware Snapshot
              </button>
            </div>

            {/* Firmware snapshot */}
            {firmwareSnapshot && (
              <div className="mt-4">
                <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-2">Exported Firmware Snapshot</div>
                <textarea
                  value={firmwareSnapshot}
                  readOnly
                  className="w-full h-64 bg-black/50 border border-white/10 rounded-lg p-3 text-[10px] text-gray-400 font-mono outline-none resize-none"
                />
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(firmwareSnapshot);
                    showStatus('📋 Copied to clipboard');
                  }}
                  className="mt-2 px-3 py-1.5 rounded bg-white/5 text-gray-500 text-[10px] hover:text-white transition-colors"
                >
                  Copy to Clipboard
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Status Bar */}
      <div className="h-7 bg-[#001020] border-t border-cyan-900/20 flex items-center px-4 text-[10px] font-mono text-gray-600 shrink-0">
        <span className="flex items-center gap-1">
          <Cpu size={10} className="text-cyan-500" />
          KERNOS BIOS v1.0
        </span>
        <span className="mx-3 flex items-center gap-1">
          <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-green-400' : 'bg-yellow-400 animate-pulse'}`} />
          {connected ? 'Connected' : 'Connecting...'}
        </span>
        <div className="flex-1" />
        {statusMsg && <span className="text-cyan-400 mx-4">{statusMsg}</span>}
        <span>Press ESC or click "Exit BIOS" to continue boot</span>
      </div>
    </div>
  );
};
