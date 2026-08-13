import React, { useState, useEffect, useRef, useCallback } from 'react';
import { kernel } from '../services/kernel';
import { Envelope } from '../types';
import {
  FolderOpen, File, ChevronRight, ChevronDown, Save, Sparkles,
  Play, X, Terminal as TerminalIcon, Code2, Brain, Search,
  FilePlus, FolderPlus, RefreshCw, Loader2, Edit2, Copy, Trash2
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

// ═══════════════════════════════════════════════════════════════
//  CDE — Cognitive Development Environment
//  A full IDE with file tree, tabbed editor, AI code review,
//  and integrated terminal.
// ═══════════════════════════════════════════════════════════════

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  expanded?: boolean;
}

interface EditorTab {
  id: string;
  name: string;
  path: string;
  content: string;
  isDirty: boolean;
  language: string;
}

function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    'ts': 'typescript', 'tsx': 'tsx', 'js': 'javascript', 'jsx': 'jsx',
    'go': 'go', 'py': 'python', 'rs': 'rust', 'md': 'markdown',
    'json': 'json', 'yaml': 'yaml', 'yml': 'yaml', 'css': 'css',
    'html': 'html', 'sql': 'sql', 'sh': 'bash', 'bash': 'bash',
    'toml': 'toml', 'xml': 'xml', 'dockerfile': 'dockerfile',
  };
  return map[ext] || 'plaintext';
}

import { useContextMenu } from '../components/ui/ContextMenu';

// ... (other imports)

// ── File Tree Component ──────────────────────────────────────

const FileTreeItem: React.FC<{
  node: FileNode;
  depth: number;
  onSelect: (node: FileNode) => void;
  onToggle: (node: FileNode) => void;
  onContextMenu?: (e: React.MouseEvent, node: FileNode) => void;
}> = ({ node, depth, onSelect, onToggle, onContextMenu }) => {
  const isDir = node.type === 'directory';
  const indent = depth * 16;
  const { showMenu } = useContextMenu();

  const handleContext = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (onContextMenu) {
      onContextMenu(e, node);
      return;
    }
    
    // Default context menu for file tree items
    showMenu(e, [
      { label: isDir ? 'Expand/Collapse' : 'Open File', icon: isDir ? <FolderOpen size={14}/> : <File size={14}/>, onClick: () => isDir ? onToggle(node) : onSelect(node) },
      { divider: true, onClick: () => {} },
      { label: 'Rename', icon: <Edit2 size={14}/>, onClick: () => console.log('Rename', node.path) },
      { label: 'Copy Path', icon: <Copy size={14}/>, onClick: () => navigator.clipboard.writeText(node.path) },
      { divider: true, onClick: () => {} },
      { label: 'Delete', icon: <Trash2 size={14}/>, danger: true, onClick: () => console.log('Delete', node.path) }
    ]);
  };

  return (
    <>
      <div
        className="flex items-center gap-1 py-0.5 px-2 hover:bg-white/5 cursor-pointer text-xs font-mono group transition-colors"
        style={{ paddingLeft: `${indent + 8}px` }}
        onClick={() => isDir ? onToggle(node) : onSelect(node)}
        onContextMenu={handleContext}
      >
        {isDir ? (
          node.expanded
            ? <ChevronDown size={12} className="text-gray-500 shrink-0" />
            : <ChevronRight size={12} className="text-gray-500 shrink-0" />
        ) : (
          <span className="w-3" />
        )}
        {isDir
          ? <FolderOpen size={13} className="text-amber-400/70 shrink-0" />
          : <File size={13} className="text-blue-400/60 shrink-0" />
        }
        <span className={`truncate ${isDir ? 'text-gray-300' : 'text-gray-400 group-hover:text-white'}`}>
          {node.name}
        </span>
      </div>
      {isDir && node.expanded && node.children?.map(child => (
        <FileTreeItem
          key={child.path}
          node={child}
          depth={depth + 1}
          onSelect={onSelect}
          onToggle={onToggle}
          onContextMenu={onContextMenu}
        />
      ))}
    </>
  );
};

// ── Main CDE Component ───────────────────────────────────────

export const CDEApp: React.FC = () => {
  // File tree state
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(true);

  // Tabs state
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  // AI panel state
  const [aiVisible, setAiVisible] = useState(false);
  const [aiStatus, setAiStatus] = useState<'idle' | 'thinking' | 'streaming'>('idle');
  const [aiMessage, setAiMessage] = useState('');

  // Terminal panel state
  const [terminalVisible, setTerminalVisible] = useState(true);
  const [terminalInput, setTerminalInput] = useState('');
  const [terminalOutput, setTerminalOutput] = useState<string[]>([
    '╔═══════════════════════════════════╗',
    '║  CDE Integrated Terminal          ║',
    '╚═══════════════════════════════════╝',
    'Type commands below. Supports all allowlisted commands.',
    ''
  ]);
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);

  const terminalEndRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  const activeTab = tabs.find(t => t.id === activeTabId) || null;

  // ── Load file tree on mount ──
  useEffect(() => {
    loadFileTree();
  }, []);

  const loadFileTree = () => {
    setTreeLoading(true);
    kernel.publish('vm.spawn', {
      _request_id: 'cde-tree',
      cmd: 'find',
      args: ['.', '-maxdepth', '3', '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*', '-not', '-path', '*/dist/*']
    });
  };

  // ── Subscribe to kernel events ──
  useEffect(() => {
    const unsub = kernel.subscribe((env: Envelope) => {
      // File tree response
      if (env.topic === 'vm.spawn:result' && (env.payload as any)?._request_id === 'cde-tree') {
        const output = (env.payload as any)?.output || '';
        const paths = output.split('\n').filter((p: string) => p.trim() && p !== '.');
        const tree = buildFileTree(paths);
        setFileTree(tree);
        setTreeLoading(false);
      }

      // File read response
      if (env.topic === 'vfs:read:resp') {
        const { id, content } = env.payload as any;
        setTabs(prev => prev.map(t => t.path === id ? { ...t, content: content || '' } : t));
      }

      // File save ack
      if (env.topic === 'vfs:write:ack') {
        const { id } = env.payload as any;
        setTabs(prev => prev.map(t => t.path === id ? { ...t, isDirty: false } : t));
      }

      // AI streaming from agent-coder
      if (env.topic === 'agent.chat:stream' && env.from === 'agent-coder') {
        setAiStatus('streaming');
        const chunk = (env.payload as any)?.chunk || '';
        setAiMessage(prev => prev + chunk);
      }
      if (env.topic === 'agent.chat:reply' && env.from === 'agent-coder') {
        setAiStatus('idle');
      }

      // Terminal output
      if (env.topic === 'vm.spawn:result') {
        const reqId = (env.payload as any)?._request_id || '';
        if (reqId.startsWith('cde-term-')) {
          const output = (env.payload as any)?.output || '';
          const error = (env.payload as any)?.error;
          setTerminalOutput(prev => [
            ...prev,
            ...(output ? output.split('\n') : []),
            ...(error ? [`❌ ${error}`] : [])
          ]);
        }
      }
    });
    return unsub;
  }, []);

  // Auto-scroll terminal
  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [terminalOutput]);

  // ── Build file tree from flat path list ──
  const buildFileTree = (paths: string[]): FileNode[] => {
    const root: Record<string, FileNode> = {};

    for (const p of paths) {
      const clean = p.replace(/^\.\//, '');
      if (!clean) continue;

      const parts = clean.split('/');
      let current = root;

      for (let i = 0; i < parts.length; i++) {
        const name = parts[i];
        const fullPath = parts.slice(0, i + 1).join('/');
        const isLast = i === parts.length - 1;

        if (!current[fullPath]) {
          current[fullPath] = {
            name,
            path: fullPath,
            type: isLast && name.includes('.') ? 'file' : 'directory',
            children: [],
            expanded: false,
          };
        }

        if (i > 0) {
          const parentPath = parts.slice(0, i).join('/');
          const parent = current[parentPath];
          if (parent && !parent.children?.find(c => c.path === fullPath)) {
            parent.children?.push(current[fullPath]);
          }
        }
      }
    }

    // Return only top-level nodes
    const topLevel: FileNode[] = [];
    for (const [path, node] of Object.entries(root)) {
      if (!path.includes('/')) {
        topLevel.push(node);
      }
    }

    // Sort: directories first, then alphabetically
    const sortNodes = (nodes: FileNode[]): FileNode[] => {
      return nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      }).map(n => ({
        ...n,
        children: n.children ? sortNodes(n.children) : undefined,
      }));
    };

    return sortNodes(topLevel);
  };

  // ── File tree actions ──
  const handleFileSelect = (node: FileNode) => {
    if (node.type !== 'file') return;

    // Check if tab already exists
    const existing = tabs.find(t => t.path === node.path);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }

    // Open new tab and load content
    const newTab: EditorTab = {
      id: Math.random().toString(36).substring(7),
      name: node.name,
      path: node.path,
      content: '// Loading...',
      isDirty: false,
      language: detectLanguage(node.name),
    };

    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);

    // Request file content
    kernel.publish('vfs:read', { _request_id: newTab.id, id: node.path });
  };

  const handleToggleDir = (node: FileNode) => {
    const toggleTree = (nodes: FileNode[]): FileNode[] => {
      return nodes.map(n => n.path === node.path
        ? { ...n, expanded: !n.expanded }
        : { ...n, children: n.children ? toggleTree(n.children) : undefined }
      );
    };
    setFileTree(toggleTree(fileTree));
  };

  // ── Tab actions ──
  const closeTab = (tabId: string) => {
    setTabs(prev => prev.filter(t => t.id !== tabId));
    if (activeTabId === tabId) {
      const remaining = tabs.filter(t => t.id !== tabId);
      setActiveTabId(remaining.length > 0 ? remaining[remaining.length - 1].id : null);
    }
  };

  const handleSave = useCallback(() => {
    if (!activeTab) return;
    kernel.publish('vfs:write', { id: activeTab.path, content: activeTab.content });
  }, [activeTab]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setShowSearch(prev => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave]);

  // ── AI Code Review ──
  const handleAiReview = () => {
    if (!activeTab) return;
    setAiVisible(true);
    setAiStatus('thinking');
    setAiMessage('');
    kernel.sendToAgent('agent-coder', 'agent.chat', {
      msg: `Review this ${activeTab.language} code for bugs, performance, and best practices. Be concise:\n\n\`\`\`${activeTab.language}\n${activeTab.content}\n\`\`\``
    });
  };

  // ── Terminal (enhanced) ──
  const handleTerminalSubmit = () => {
    const cmd = terminalInput.trim();
    if (!cmd) return;

    setCmdHistory(prev => [cmd, ...prev].slice(0, 50));
    setHistoryIdx(-1);
    setTerminalOutput(prev => [...prev, `$ ${cmd}`]);
    setTerminalInput('');

    // Built-in commands
    if (cmd === 'clear' || cmd === 'cls') {
      setTerminalOutput([]);
      return;
    }
    if (cmd === 'help') {
      setTerminalOutput(prev => [...prev, 'Type any allowlisted command. Use "clear" to reset.']);
      return;
    }

    const parts = cmd.split(' ');
    const reqId = `cde-term-${Date.now()}`;
    kernel.publish('vm.spawn', {
      _request_id: reqId,
      cmd: parts[0],
      args: parts.slice(1)
    });
  };

  const handleTerminalKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleTerminalSubmit();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (cmdHistory.length > 0) {
        const newIdx = Math.min(historyIdx + 1, cmdHistory.length - 1);
        setHistoryIdx(newIdx);
        setTerminalInput(cmdHistory[newIdx]);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIdx > 0) {
        const newIdx = historyIdx - 1;
        setHistoryIdx(newIdx);
        setTerminalInput(cmdHistory[newIdx]);
      } else {
        setHistoryIdx(-1);
        setTerminalInput('');
      }
    }
  };

  // ── Content update ──
  const updateContent = (newContent: string) => {
    if (!activeTabId) return;
    setTabs(prev => prev.map(t =>
      t.id === activeTabId ? { ...t, content: newContent, isDirty: true } : t
    ));
  };

  // ═══════════════════════════════════════════════════════════
  //  RENDER
  // ═══════════════════════════════════════════════════════════

  return (
    <div className="h-full flex flex-col bg-[#0a0a0f] text-white overflow-hidden select-none font-sans">
      {/* ── Top Toolbar ── */}
      <div className="h-10 bg-[#0f0f13]/90 backdrop-blur-md border-b border-white/5 flex items-center px-4 gap-2 shrink-0 z-10 shadow-sm shadow-black/20">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-cyan-500/10 rounded-lg border border-cyan-500/20">
            <Sparkles size={14} className="text-cyan-400" />
          </div>
          <div className="flex flex-col">
            <span className="text-[11px] font-bold tracking-widest text-gray-200">CDE</span>
            <span className="text-[9px] text-gray-500 uppercase tracking-widest font-mono">Cognitive Env</span>
          </div>
        </div>

        <div className="flex-1" />

        <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={handleSave} className="p-1.5 rounded-md hover:bg-white/10 text-gray-400 hover:text-green-400 transition-colors" title="Save (⌘S)">
          <Save size={14} />
        </motion.button>
        <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={() => setShowSearch(prev => !prev)} className={`p-1.5 rounded-md hover:bg-white/10 transition-colors ${showSearch ? 'bg-white/10 text-white' : 'text-gray-400 hover:text-white'}`} title="Find (⌘F)">
          <Search size={14} />
        </motion.button>
        <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={handleAiReview} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-purple-500/15 hover:bg-purple-500/25 border border-purple-500/30 text-purple-400 text-[10px] font-bold transition-all shadow-[0_0_10px_rgba(168,85,247,0.1)]" title="AI Code Review">
          <Brain size={12} />
          <span>AI REVIEW</span>
        </motion.button>
        <div className="w-px h-5 bg-white/10 mx-1" />
        <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={() => setTerminalVisible(prev => !prev)} className={`p-1.5 rounded-md hover:bg-white/10 transition-all ${terminalVisible ? 'text-cyan-400 bg-cyan-500/10 shadow-[0_0_10px_rgba(0,240,255,0.1)]' : 'text-gray-400'}`} title="Toggle Terminal">
          <TerminalIcon size={14} />
        </motion.button>
      </div>

      {/* ── Search Bar (conditional, animated) ── */}
      <AnimatePresence>
        {showSearch && (
          <motion.div 
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 36, opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="bg-[#15151a] border-b border-white/5 flex items-center px-4 gap-3 shrink-0 overflow-hidden"
          >
            <Search size={14} className="text-gray-500" />
            <input
              type="text"
              placeholder="Search in file..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="flex-1 bg-transparent text-xs text-white outline-none placeholder-gray-600 font-mono"
              autoFocus
            />
            <button onClick={() => setShowSearch(false)} className="p-1 rounded hover:bg-white/10 text-gray-500 hover:text-white transition-colors">
              <X size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Main Content Area ── */}
      <div className="flex-1 flex overflow-hidden">
        {/* ── File Tree Panel ── */}
        <div className="w-56 bg-[#0a0a0f]/50 border-r border-white/5 flex flex-col shrink-0 overflow-hidden backdrop-blur-sm">
          <div className="h-10 px-4 flex items-center justify-between border-b border-white/5 shrink-0 bg-[#0f0f13]/50">
            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Explorer</span>
            <div className="flex items-center gap-1">
              <button onClick={loadFileTree} className="p-1.5 rounded-md hover:bg-white/10 text-gray-500 hover:text-white transition-colors" title="Refresh">
                <RefreshCw size={12} />
              </button>
              <button className="p-1.5 rounded-md hover:bg-white/10 text-gray-500 hover:text-white transition-colors" title="New File">
                <FilePlus size={12} />
              </button>
              <button className="p-1.5 rounded-md hover:bg-white/10 text-gray-500 hover:text-white transition-colors" title="New Folder">
                <FolderPlus size={12} />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto py-2 px-1">
            {treeLoading ? (
              <div className="flex items-center gap-2 px-4 py-3 text-cyan-400/70 text-xs font-mono">
                <Loader2 size={14} className="animate-spin" />
                Scanning VFS...
              </div>
            ) : (
              fileTree.map(node => (
                <FileTreeItem
                  key={node.path}
                  node={node}
                  depth={0}
                  onSelect={handleFileSelect}
                  onToggle={handleToggleDir}
                />
              ))
            )}
          </div>
        </div>

        {/* ── Editor + AI Panel ── */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Tab Bar */}
          <div className="h-8 bg-[#161b22] border-b border-[#21262d] flex items-center overflow-x-auto shrink-0">
            {tabs.map(tab => (
              <div
                key={tab.id}
                className={`flex items-center gap-1.5 px-3 h-full border-r border-[#21262d] cursor-pointer text-xs font-mono whitespace-nowrap transition-colors ${
                  tab.id === activeTabId
                    ? 'bg-[#0d1117] text-white border-t-2 border-t-cyan-500'
                    : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'
                }`}
                onClick={() => setActiveTabId(tab.id)}
              >
                <Code2 size={11} className={tab.language === 'go' ? 'text-cyan-400' : tab.language === 'typescript' || tab.language === 'tsx' ? 'text-blue-400' : 'text-gray-500'} />
                <span>{tab.name}</span>
                {tab.isDirty && <span className="text-amber-400 text-lg leading-none">•</span>}
                <button
                  onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                  className="ml-1 p-0.5 rounded hover:bg-white/10 text-gray-600 hover:text-white opacity-0 group-hover:opacity-100"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>

          {/* Editor + AI Side Panel */}
          <div className="flex-1 flex overflow-hidden bg-[#0d0d12]">
            {/* Code Editor */}
            <div className="flex-1 flex flex-col overflow-hidden relative group">
              {activeTab ? (
                <div className="flex-1 flex overflow-hidden">
                  {/* Line Numbers */}
                  <div className="w-12 bg-[#0a0a0f]/80 border-r border-white/5 flex flex-col items-end pr-3 pt-4 text-[11px] text-gray-700 font-mono select-none overflow-hidden backdrop-blur-sm z-10">
                    {activeTab.content.split('\n').map((_, i) => (
                      <div key={i} className="leading-6">{i + 1}</div>
                    ))}
                  </div>
                  {/* Text Area Container */}
                  <div className="flex-1 relative overflow-hidden bg-transparent">
                    {/* Active Line Highlight overlay */}
                    <div className="absolute top-0 left-0 w-full h-full pointer-events-none z-0">
                      <div className="w-full h-6 bg-white/[0.02]" />
                    </div>
                    {/* The actual editor */}
                    <textarea
                      ref={editorRef}
                      className="absolute inset-0 w-full h-full bg-transparent text-gray-300 font-mono text-[13px] leading-6 p-4 pt-4 outline-none border-none resize-none z-10 custom-scrollbar caret-cyan-400 focus:shadow-[inset_0_0_20px_rgba(0,240,255,0.03)] transition-shadow"
                      value={activeTab.content}
                      onChange={e => updateContent(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Tab') {
                          e.preventDefault();
                          const start = e.currentTarget.selectionStart;
                          const end = e.currentTarget.selectionEnd;
                          const newContent = activeTab.content.substring(0, start) + '  ' + activeTab.content.substring(end);
                          updateContent(newContent);
                          setTimeout(() => {
                            if (editorRef.current) {
                              editorRef.current.selectionStart = editorRef.current.selectionEnd = start + 2;
                            }
                          }, 0);
                        }
                      }}
                      spellCheck={false}
                    />
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-gray-600 gap-4 bg-[#0a0a0f]/50">
                  <div className="relative">
                    <Brain size={64} className="opacity-10 text-cyan-400" />
                    <Sparkles size={20} className="absolute -top-2 -right-2 opacity-20 text-purple-400" />
                  </div>
                  <div className="text-[13px] font-bold tracking-widest text-gray-400">Cognitive Development Environment</div>
                  <div className="text-xs text-gray-600 font-mono">Open a file from the explorer to begin</div>
                  <div className="text-[10px] text-gray-700 mt-4 flex justify-center gap-6">
                    <span className="flex items-center gap-1.5"><Save size={12}/> ⌘S to Save</span>
                    <span className="flex items-center gap-1.5"><Search size={12}/> ⌘F to Find</span>
                  </div>
                </div>
              )}
            </div>

            {/* AI Code Review Panel */}
            <AnimatePresence>
              {aiVisible && (
                <motion.div 
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: 300, opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  className="bg-[#0f0f13]/90 border-l border-white/5 flex flex-col shrink-0 backdrop-blur-md shadow-[-10px_0_30px_rgba(0,0,0,0.5)]"
                >
                  <div className="h-10 px-4 flex items-center justify-between border-b border-white/5 shrink-0 bg-purple-500/[0.02]">
                    <div className="flex items-center gap-2">
                      <Sparkles size={12} className="text-purple-400" />
                      <span className="text-[10px] font-bold text-gray-300 uppercase tracking-widest">AI Analysis</span>
                    </div>
                    <button onClick={() => setAiVisible(false)} className="text-gray-500 hover:text-white transition-colors p-1 hover:bg-white/10 rounded">
                      <X size={14} />
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto p-4 textxs text-gray-300 font-sans leading-relaxed whitespace-pre-wrap custom-scrollbar">
                    {aiMessage}
                    {aiStatus === 'thinking' && (
                      <div className="flex items-center gap-3 text-purple-400 mt-4 bg-purple-500/10 p-3 rounded-lg border border-purple-500/20">
                        <Loader2 size={14} className="animate-spin" />
                        <span className="font-mono text-[11px] tracking-wide">agent-coder analyzing...</span>
                      </div>
                    )}
                    {aiStatus === 'streaming' && <span className="text-purple-400 animate-pulse ml-1 text-lg leading-none">▊</span>}
                    {!aiMessage && aiStatus === 'idle' && (
                      <div className="text-gray-500 text-center mt-12 flex flex-col items-center gap-3 text-xs px-4">
                        <Brain size={24} className="opacity-20 text-purple-400" />
                        Click "AI Review" in the top bar to run a deep analysis on the currently open file using the Codestral 22B agent.
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* ── Integrated Terminal ── */}
          <AnimatePresence>
            {terminalVisible && (
              <motion.div 
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 180, opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="bg-[#050508] border-t border-white/5 flex flex-col shrink-0 relative shadow-[0_-10px_30px_rgba(0,0,0,0.5)]"
              >
                <div className="h-8 px-4 flex items-center gap-2 border-b border-white/5 bg-[#0a0a0f] shrink-0">
                  <TerminalIcon size={12} className="text-cyan-400" />
                  <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">CDE Terminal</span>
                </div>
                <div className="flex-1 overflow-y-auto px-4 py-2 font-mono text-[11px] leading-relaxed text-gray-400 custom-scrollbar">
                  {terminalOutput.map((line, i) => (
                    <div key={i} className={`
                      ${line.startsWith('$') ? 'text-cyan-400 font-bold mt-1' : ''}
                      ${line.startsWith('❌') ? 'text-red-400' : ''}
                      ${line.includes('════') ? 'text-gray-600' : ''}
                    `}>
                      {line}
                    </div>
                  ))}
                  <div ref={terminalEndRef} />
                </div>
                <div className="h-8 px-4 flex items-center gap-3 border-t border-white/5 shrink-0 bg-[#0a0a0f]/50">
                  <span className="text-cyan-400 text-xs font-mono font-bold">❯</span>
                  <input
                    type="text"
                    value={terminalInput}
                    onChange={e => setTerminalInput(e.target.value)}
                    onKeyDown={handleTerminalKeyDown}
                    className="flex-1 bg-transparent text-xs text-white font-mono outline-none placeholder-gray-600"
                    placeholder="Enter command (e.g., node script.js)..."
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* ── Status Bar ── */}
      <div className="h-6 bg-[#161b22] border-t border-[#30363d] flex items-center px-3 gap-4 text-[10px] font-mono text-gray-600 shrink-0">
        <span className="flex items-center gap-1">
          <Brain size={10} className="text-cyan-500" />
          CDE v1.0
        </span>
        {activeTab && (
          <>
            <span>{activeTab.language}</span>
            <span>Ln {activeTab.content.split('\n').length}</span>
            <span>{activeTab.isDirty ? '● Modified' : '✓ Saved'}</span>
          </>
        )}
        <div className="flex-1" />
        <span>Codestral 22B</span>
        <span>UTF-8</span>
      </div>
    </div>
  );
};
