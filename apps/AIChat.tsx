import React, { useEffect, useState, useRef, useCallback } from 'react';
import { kernel } from '../services/kernel';
import { Envelope } from '../types';
import { extractToolCall, stripToolBlock, runLocalModelTool } from '../lib/localModelTools';
import { getCurrentUserId } from '../lib/auth';
import { trackEvent } from '../lib/analytics';
import { Bot, Send, Loader2, ChevronDown, ChevronRight, Zap, ImagePlus, Brain, Plus, MessageSquare, Trash2, Clock } from 'lucide-react';

interface ChatMessage {
    id: string;
    role: 'user' | 'agent';
    content: string;
    thinking?: string;
    agentId?: string;
    time: string;
}

interface AgentInfo {
    id: string;
    name: string;
    model: string;
    role: string;
}

interface ConversationMeta {
    id: string;
    title: string;
    agent_id: string;
    updated_at: string;
}

// Extract thinking and response as separate parts
function extractThinking(text: string): { thinking: string; response: string } {
    let thinking = '';
    let response = text;
    const thinkMatches = text.match(/<think>([\s\S]*?)<\/think>/g);
    if (thinkMatches) {
        thinking = thinkMatches
            .map(m => m.replace(/<\/?think>/g, '').trim())
            .join('\n\n');
        response = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    }
    const unclosed = response.match(/<think>([\s\S]*)$/);
    if (unclosed) {
        thinking += (thinking ? '\n\n' : '') + unclosed[1].trim();
        response = response.replace(/<think>[\s\S]*$/, '').trim();
    }
    return { thinking, response };
}

// Collapsible thinking block component
const ThinkingBlock: React.FC<{ content: string; isStreaming?: boolean }> = ({ content, isStreaming }) => {
    const [expanded, setExpanded] = useState(false);
    if (!content) return null;
    return (
        <div className="mb-2">
            <button
                onClick={() => setExpanded(!expanded)}
                className="flex items-center gap-1.5 text-[10px] text-amber-400/70 hover:text-amber-400 transition-colors font-mono"
            >
                {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                <Brain size={10} />
                <span>Thinking{isStreaming ? '...' : ''}</span>
                {!expanded && <span className="text-gray-600 ml-1">({content.split('\n').length} lines)</span>}
            </button>
            {expanded && (
                <div className="mt-1 ml-4 pl-2 border-l border-amber-500/20 text-[11px] text-gray-500 whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
                    {content}
                    {isStreaming && <span className="animate-pulse text-amber-400">▊</span>}
                </div>
            )}
        </div>
    );
};

export const AIChatApp: React.FC = () => {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [agents, setAgents] = useState<AgentInfo[]>([]);
    const agentsRef = useRef<AgentInfo[]>([]);
    const [selectedAgent, setSelectedAgent] = useState<string>('');
    const [isWaiting, setIsWaiting] = useState(false);
    const [showSelector, setShowSelector] = useState(false);
    const [directMode, setDirectMode] = useState(false);
    const [streamBuffer, setStreamBuffer] = useState('');
    // Mirrors streamBuffer for synchronous reads inside the kernel.subscribe
    // handler below — see the 'agent.chat:reply' case for why this matters.
    const streamBufferRef = useRef('');
    useEffect(() => { streamBufferRef.current = streamBuffer; }, [streamBuffer]);
    const bottomRef = useRef<HTMLDivElement>(null);
    const agentCheckTimer = useRef<ReturnType<typeof setTimeout>>();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [imagePreview, setImagePreview] = useState<string | null>(null);
    const [imageBase64, setImageBase64] = useState<string | null>(null);

    // ── Chat History State ──
    const [conversationId, setConversationId] = useState<string>(() => `chat-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`);
    const [conversations, setConversations] = useState<ConversationMeta[]>([]);
    const [showHistory, setShowHistory] = useState(false);
    // Resolved async (real Supabase session vs. saved guest id vs. last-resort
    // 'guest') — starts as 'guest' so the very first chat.list still fires
    // something, then re-fires once the real id resolves (see the effect
    // below and its [userId] dependency on chat.list's own effect).
    const [userId, setUserId] = useState('guest');
    useEffect(() => {
        getCurrentUserId().then(setUserId);
    }, []);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, streamBuffer]);

    useEffect(() => {
        agentsRef.current = agents;
    }, [agents]);

    // After 3 seconds, if no agents connected, switch to direct LM mode.
    // Reads agentsRef (kept in sync below) rather than `agents` directly —
    // these closures are created once on mount and would otherwise always
    // see the initial empty array, permanently forcing direct mode.
    useEffect(() => {
        kernel.publish('agent.roster', {});
        agentCheckTimer.current = setTimeout(() => {
            if (agentsRef.current.length === 0) {
                kernel.publish('agent.roster', {});
                setTimeout(() => {
                    if (agentsRef.current.length === 0) {
                        setDirectMode(true);
                    }
                }, 3000);
            }
        }, 3000);
        return () => { if (agentCheckTimer.current) clearTimeout(agentCheckTimer.current); };
    }, []);

    // Load conversation list on mount
    useEffect(() => {
        kernel.publish('chat.list', { user_id: userId });
    }, [userId]);

    // Auto-save conversation when messages change
    const saveConversation = useCallback(() => {
        if (messages.length === 0) return;
        // Auto-title from first user message
        const firstUserMsg = messages.find(m => m.role === 'user');
        const title = firstUserMsg
            ? firstUserMsg.content.substring(0, 60) + (firstUserMsg.content.length > 60 ? '...' : '')
            : 'New Chat';
        kernel.publish('chat.save', {
            id: conversationId,
            user_id: userId,
            title,
            agent_id: selectedAgent || 'kernos-lm',
            messages,
        });
    }, [messages, conversationId, userId, selectedAgent]);

    useEffect(() => {
        if (messages.length > 0) {
            const timer = setTimeout(saveConversation, 1000); // debounce 1s
            return () => clearTimeout(timer);
        }
    }, [messages, saveConversation]);

    useEffect(() => {
        const unsub = kernel.subscribe((env: Envelope) => {
            // Track agent list from live connections
            if (env.topic === 'sys.client_list') {
                const payload = env.payload as any;
                const clients = (payload?.clients || []) as AgentInfo[];
                const agentClients = clients.filter((c: AgentInfo) => c.role === 'agent');
                if (agentClients.length > 0) {
                    setAgents(agentClients);
                    setDirectMode(false);
                    setSelectedAgent(prev => {
                        if (prev) return prev;
                        const chatAgent = agentClients.find(a => a.id === 'agent-chat');
                        return chatAgent ? chatAgent.id : agentClients[0].id;
                    });
                }
            }

            // Track agent list from kernel roster
            if (env.topic === 'agent.roster:resp') {
                const rosterAgents = (env.payload?.agents || []) as AgentInfo[];
                if (rosterAgents.length > 0) {
                    setAgents(prev => {
                        const liveIds = new Set(prev.filter(a => a.role === 'agent').map(a => a.id));
                        const merged = [...prev];
                        for (const ra of rosterAgents) {
                            if (!liveIds.has(ra.id)) merged.push(ra);
                        }
                        return merged.length > prev.length ? merged : prev;
                    });
                    setDirectMode(false);
                    setSelectedAgent(prev => prev || rosterAgents[0].id);
                }
            }

            // ── Chat History Responses ──
            if (env.topic === 'chat.list:resp') {
                const convos = (env.payload as any)?.conversations || [];
                setConversations(convos);
            }
            if (env.topic === 'chat.load:resp') {
                const p = env.payload as any;
                if (p?.messages) {
                    setMessages(p.messages);
                    setConversationId(p.id);
                    if (p.agent_id) setSelectedAgent(p.agent_id);
                    setShowHistory(false);
                }
            }
            if (env.topic === 'chat.save:resp') {
                // Refresh list after save
                kernel.publish('chat.list', { user_id: userId });
            }
            if (env.topic === 'chat.delete:resp') {
                kernel.publish('chat.list', { user_id: userId });
            }

            // ── AI Responses ──
            if (env.topic === 'agent.chat:reply') {
                const payload = env.payload as any;
                const fallback = payload?.reply || '(no response)';
                const agentId = env.from;
                // Read via the ref, not a setStreamBuffer(prev => ...) updater —
                // React 18 StrictMode double-invokes updater functions passed to
                // setState to catch exactly this: side effects (setMessages,
                // kicking off a tool-call) nested inside another setState's
                // updater get called twice, producing duplicate messages and
                // (worse) a tool call actually running twice. Doing the state
                // reads/writes as plain top-level calls in this handler avoids
                // that entirely — kernel.subscribe callbacks aren't updater
                // functions, so they're never double-invoked.
                const raw = streamBufferRef.current || fallback;
                const { thinking, response } = extractThinking(raw);
                const toolCall = extractToolCall(response);
                const displayResponse = toolCall ? stripToolBlock(response) : response;
                if (displayResponse || thinking) {
                    setMessages(msgs => [...msgs, {
                        id: Math.random().toString(36),
                        role: 'agent',
                        content: displayResponse || '(thinking only)',
                        thinking: thinking || undefined,
                        agentId,
                        time: new Date().toLocaleTimeString()
                    }]);
                }
                if (toolCall) {
                    const publishResult = (content: string) => {
                        setMessages(msgs => [...msgs, {
                            id: Math.random().toString(36),
                            role: 'agent',
                            content,
                            agentId: 'bnlm-local',
                            time: new Date().toLocaleTimeString()
                        }]);
                    };
                    runLocalModelTool(toolCall)
                        .then(result => publishResult(`🧠 ${result}`))
                        .catch((err: any) => publishResult(`⚠️ ${err?.message || err}`));
                }
                setStreamBuffer('');
                setIsWaiting(false);
            }

            if (env.topic === 'agent.chat:stream') {
                const payload = env.payload as any;
                const chunk = payload.chunk || '';
                setStreamBuffer(prev => prev + chunk);
                setIsWaiting(false);
            }

            if (env.topic === 'ai.stream') {
                setStreamBuffer(prev => prev + (env.payload.chunk || ''));
                setIsWaiting(false);
            }

            if (env.topic === 'ai.done') {
                // Same fix as 'agent.chat:reply' above — read via the ref
                // instead of nesting setMessages inside a setStreamBuffer updater.
                const prev = streamBufferRef.current;
                if (prev) {
                    const { thinking, response } = extractThinking(prev);
                    setMessages(msgs => [...msgs, {
                        id: Math.random().toString(36),
                        role: 'agent',
                        content: response || '(thinking only)',
                        thinking: thinking || undefined,
                        agentId: 'kernos-lm',
                        time: new Date().toLocaleTimeString()
                    }]);
                }
                setStreamBuffer('');
                setIsWaiting(false);
            }
        });
        return unsub;
    }, [selectedAgent, userId]);

    // ── New Chat ──
    const startNewChat = () => {
        setMessages([]);
        setStreamBuffer('');
        setConversationId(`chat-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`);
        setIsWaiting(false);
    };

    // ── Load conversation ──
    const loadConversation = (id: string) => {
        kernel.publish('chat.load', { id, user_id: userId });
    };

    // ── Delete conversation ──
    const deleteConversation = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        kernel.publish('chat.delete', { id, user_id: userId });
        if (id === conversationId) startNewChat();
    };

    const sendMessage = () => {
        const msg = input.trim();
        if (!msg) return;
        if (!directMode && !selectedAgent) return;

        trackEvent('chat_message_sent', { agent_id: directMode ? 'direct' : selectedAgent, has_image: !!imageBase64 });

        setMessages(prev => [...prev, {
            id: Math.random().toString(36),
            role: 'user',
            content: msg,
            time: new Date().toLocaleTimeString()
        }]);

        if (directMode) {
            const reqId = Math.random().toString(36).substring(7);
            if (imageBase64) {
                kernel.publish('ai.chat', { _request_id: reqId, prompt: msg, image: imageBase64 });
            } else {
                kernel.publish('ai.chat', { _request_id: reqId, prompt: msg });
            }
        } else {
            // `messages` here is still the pre-update state (setState above
            // hasn't re-rendered yet) — exactly the prior turns, not
            // including the user message just sent as `msg`.
            const history = messages.slice(-10).map(m => ({ role: m.role, content: m.content }));
            if (imageBase64) {
                kernel.sendToAgent(selectedAgent, 'agent.chat', { msg, image: imageBase64, history });
            } else {
                kernel.sendToAgent(selectedAgent, 'agent.chat', { msg, history });
            }
        }

        setInput('');
        setIsWaiting(true);
        setStreamBuffer('');
        setImagePreview(null);
        setImageBase64(null);
    };

    const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result as string;
            setImagePreview(result);
            setImageBase64(result.split(',')[1] || result);
        };
        reader.readAsDataURL(file);
    };

    const currentAgent = agents.find(a => a.id === selectedAgent);

    return (
        <div className="h-full flex bg-[#0a0a0f] text-gray-200">
            {/* ── History Sidebar ── */}
            {showHistory && (
                <div className="w-64 bg-[#0d0d14] border-r border-white/5 flex flex-col shrink-0">
                    <div className="p-3 border-b border-white/5 flex items-center justify-between">
                        <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">Chat History</span>
                        <button onClick={() => setShowHistory(false)} className="text-gray-600 hover:text-white text-xs">✕</button>
                    </div>
                    <div className="flex-1 overflow-y-auto">
                        {conversations.length === 0 ? (
                            <div className="p-4 text-xs text-gray-600 text-center">No saved conversations</div>
                        ) : (
                            conversations.map(conv => (
                                <div
                                    key={conv.id}
                                    onClick={() => loadConversation(conv.id)}
                                    className={`px-3 py-2.5 border-b border-white/5 cursor-pointer hover:bg-white/5 transition-colors group ${conv.id === conversationId ? 'bg-purple-500/10 border-l-2 border-l-purple-500' : ''}`}
                                >
                                    <div className="flex items-start justify-between">
                                        <div className="flex-1 min-w-0">
                                            <div className="text-xs text-gray-300 truncate font-medium">{conv.title}</div>
                                            <div className="flex items-center gap-1 mt-0.5">
                                                <Clock size={8} className="text-gray-600" />
                                                <span className="text-[9px] text-gray-600">{new Date(conv.updated_at).toLocaleDateString()}</span>
                                                {conv.agent_id && <span className="text-[9px] text-purple-500 ml-1">{conv.agent_id}</span>}
                                            </div>
                                        </div>
                                        <button
                                            onClick={(e) => deleteConversation(conv.id, e)}
                                            className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-500/20 text-gray-600 hover:text-red-400 transition-all"
                                        >
                                            <Trash2 size={10} />
                                        </button>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            )}

            {/* ── Main Chat Area ── */}
            <div className="flex-1 flex flex-col">
                {/* Header */}
                <div className="p-3 border-b border-white/5 bg-white/[0.03] flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        {/* History toggle */}
                        <button
                            data-tour="chat-history"
                            onClick={() => { setShowHistory(prev => !prev); kernel.publish('chat.list', { user_id: userId }); }}
                            className={`p-1.5 rounded transition-colors ${showHistory ? 'bg-purple-500/20 text-purple-400' : 'hover:bg-white/10 text-gray-500 hover:text-white'}`}
                            title="Chat History"
                        >
                            <MessageSquare size={14} />
                        </button>
                        {/* New Chat */}
                        <button
                            data-tour="chat-new"
                            onClick={startNewChat}
                            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
                            title="New Chat"
                        >
                            <Plus size={12} />
                            <span>New Chat</span>
                        </button>
                        <div className="w-px h-4 bg-white/10" />
                        <Bot size={16} className="text-purple-400" />
                        <span className="text-sm font-medium text-white">AI Chat</span>
                        {directMode && (
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 flex items-center gap-1">
                                <Zap size={8} /> Direct LM
                            </span>
                        )}
                    </div>
                    {!directMode ? (
                        <div className="relative">
                            <button
                                data-tour="chat-agent-selector"
                                onClick={() => setShowSelector(!showSelector)}
                                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs hover:bg-white/10 transition-colors"
                            >
                                <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                                <span>{currentAgent?.name || currentAgent?.id || 'No agent'}</span>
                                <ChevronDown size={12} />
                            </button>
                            {showSelector && agents.length > 0 && (
                                <div className="absolute right-0 top-full mt-1 bg-[#15151a] border border-white/10 rounded-lg shadow-xl z-50 min-w-[220px] overflow-hidden">
                                    {agents.map(agent => (
                                        <button
                                            key={agent.id}
                                            onClick={() => { setSelectedAgent(agent.id); setShowSelector(false); }}
                                            className={`w-full text-left px-4 py-3 text-xs hover:bg-white/5 transition-colors border-b border-white/5 last:border-0 ${agent.id === selectedAgent ? 'bg-purple-500/10 text-purple-300' : 'text-gray-400'
                                                }`}
                                        >
                                            <div className="font-medium text-white">{agent.name || agent.id}</div>
                                            <div className="text-[10px] text-gray-500 mt-0.5 font-mono">{agent.model}</div>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    ) : (
                        <button
                            onClick={() => { setDirectMode(false); kernel.publish('agent.roster', {}); }}
                            className="text-[10px] px-2 py-1 rounded bg-white/5 text-gray-500 hover:text-white transition-colors"
                        >
                            Switch to Agent Mode
                        </button>
                    )}
                </div>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {messages.length === 0 && !streamBuffer && (
                        <div className="flex flex-col items-center justify-center h-full text-center opacity-40">
                            <Bot size={40} className="text-purple-400 mb-3" />
                            <p className="text-sm text-gray-500">
                                {directMode
                                    ? 'Chat directly with the Kernos LM engine.'
                                    : 'Send a message to talk to a Kernos agent.'}
                            </p>
                            <p className="text-xs text-gray-600 mt-1">
                                {directMode
                                    ? 'Your messages go to the embedded AI model.'
                                    : 'Select an agent from the dropdown above.'}
                            </p>
                            <p className="text-[10px] text-gray-700 mt-3">Conversations are auto-saved.</p>
                        </div>
                    )}
                    {messages.map(msg => (
                        <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                            <div className={`max-w-[80%] rounded-xl px-4 py-3 text-sm leading-relaxed ${msg.role === 'user'
                                ? 'bg-purple-600/20 border border-purple-500/20 text-gray-200'
                                : 'bg-white/5 border border-white/5 text-gray-300'
                                }`}>
                                {msg.role === 'agent' && (
                                    <div className="text-[10px] text-purple-400 mb-1 font-mono">{msg.agentId}</div>
                                )}
                                {msg.thinking && <ThinkingBlock content={msg.thinking} />}
                                <div className="whitespace-pre-wrap">{msg.content}</div>
                                <div className="text-[10px] text-gray-600 mt-2">{msg.time}</div>
                            </div>
                        </div>
                    ))}
                    {/* Live streaming buffer */}
                    {streamBuffer && (() => {
                        const { thinking, response } = extractThinking(streamBuffer);
                        return (
                            <div className="flex justify-start">
                                <div className="max-w-[80%] rounded-xl px-4 py-3 text-sm leading-relaxed bg-white/5 border border-white/5 text-gray-300">
                                    <div className="text-[10px] text-cyan-400 mb-1 font-mono">{directMode ? 'kernos-lm' : (currentAgent?.id || 'agent')}</div>
                                    {thinking && <ThinkingBlock content={thinking} isStreaming={!response} />}
                                    {response && <div className="whitespace-pre-wrap">{response}<span className="animate-pulse">▊</span></div>}
                                    {!response && !thinking && <div className="whitespace-pre-wrap">{streamBuffer}<span className="animate-pulse">▊</span></div>}
                                </div>
                            </div>
                        );
                    })()}
                    {isWaiting && !streamBuffer && (
                        <div className="flex justify-start">
                            <div className="bg-white/5 border border-white/5 rounded-xl px-4 py-3 flex items-center gap-2 text-gray-500 text-sm">
                                <Loader2 size={14} className="animate-spin" />
                                <span>{directMode ? 'Kernos LM' : currentAgent?.name || 'Agent'} is thinking...</span>
                            </div>
                        </div>
                    )}
                    <div ref={bottomRef} />
                </div>

                {/* Input */}
                <div className="p-3 border-t border-white/5 bg-white/[0.02]">
                    {imagePreview && (
                        <div className="mb-2 relative inline-block">
                            <img src={imagePreview} alt="upload" className="h-16 rounded border border-white/10" />
                            <button
                                onClick={() => { setImagePreview(null); setImageBase64(null); }}
                                className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full w-4 h-4 flex items-center justify-center text-[10px]"
                            >✕</button>
                        </div>
                    )}
                    <div className="flex gap-2">
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/*"
                            onChange={handleImageSelect}
                            className="hidden"
                        />
                        <button
                            data-tour="chat-image"
                            onClick={() => fileInputRef.current?.click()}
                            className="px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-gray-400 hover:text-cyan-400 hover:border-cyan-500/30 transition-colors"
                            title="Attach image for VL analysis"
                        >
                            <ImagePlus size={16} />
                        </button>
                        <input
                            data-tour="chat-input"
                            type="text"
                            value={input}
                            onChange={e => setInput(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && sendMessage()}
                            placeholder={imageBase64 ? 'Describe what you want to know about this image...' : (directMode ? 'Ask the Kernos AI anything...' : `Message ${currentAgent?.name || 'agent'}...`)}
                            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-purple-500/50 transition-colors"
                        />
                        <button
                            onClick={sendMessage}
                            disabled={!input.trim() || (!directMode && !selectedAgent)}
                            className="px-4 py-2.5 bg-purple-600 hover:bg-purple-500 disabled:bg-gray-800 disabled:text-gray-600 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                        >
                            <Send size={14} />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
