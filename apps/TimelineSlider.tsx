import React, { useState, useEffect, useCallback } from 'react';
import { kernel } from '../services/kernel';
import { Envelope } from '../types';
import { Clock, RotateCcw, Play, ChevronLeft, ChevronRight } from 'lucide-react';

interface TimelineEntry {
    id: string;
    topic: string;
    from: string;
    summary: string;
    time: string;
    index: number;
}

export const TimelineSlider: React.FC = () => {
    const [entries, setEntries] = useState<TimelineEntry[]>([]);
    const [sliderPos, setSliderPos] = useState(0);
    const [selectedEntry, setSelectedEntry] = useState<TimelineEntry | null>(null);
    const [isReplaying, setIsReplaying] = useState(false);

    // Capture meaningful events from the kernel bus
    useEffect(() => {
        const unsub = kernel.subscribe((env: Envelope) => {
            const trackedTopics = [
                'vm.stdout', 'vm.stderr', 'vm.spawn',
                'task.event', 'task.done',
                'agent.chat:reply', 'ai.done',
                'pkg.install:done',
                'vfs:write',
            ];
            if (trackedTopics.includes(env.topic)) {
                const summary = getSummary(env);
                setEntries(prev => {
                    const next = [...prev, {
                        id: Math.random().toString(36),
                        topic: env.topic,
                        from: env.from || 'kernel',
                        summary,
                        time: new Date().toLocaleTimeString(),
                        index: prev.length,
                    }];
                    setSliderPos(next.length - 1);
                    return next.slice(-100); // Keep last 100
                });
            }
        });
        return unsub;
    }, []);

    const getSummary = (env: Envelope): string => {
        const p = env.payload as any;
        switch (env.topic) {
            case 'vm.stdout': return `Output: ${(p?.text || '').slice(0, 60)}`;
            case 'vm.stderr': return `Error: ${(p?.text || '').slice(0, 60)}`;
            case 'vm.spawn': return `Executed: ${p?.cmd || 'unknown'} ${(p?.args || []).join(' ')}`;
            case 'task.event': return `Task: ${p?.step || 'progress'}`;
            case 'task.done': return `Task completed: ${p?.runId || ''}`;
            case 'agent.chat:reply': return `Agent replied: ${(p?.reply || '').slice(0, 50)}`;
            case 'ai.done': return 'AI generation completed';
            case 'pkg.install:done': return `Package installed: ${p?.pkgName || ''}`;
            case 'vfs:write': return `File written: ${p?.path || ''}`;
            default: return env.topic;
        }
    };

    const handleSliderChange = useCallback((value: number) => {
        setSliderPos(value);
        if (entries[value]) {
            setSelectedEntry(entries[value]);
        }
    }, [entries]);

    const handleReplay = () => {
        if (entries.length === 0) return;
        setIsReplaying(true);
        let i = 0;
        const interval = setInterval(() => {
            if (i >= entries.length) {
                clearInterval(interval);
                setIsReplaying(false);
                return;
            }
            setSliderPos(i);
            setSelectedEntry(entries[i]);
            i++;
        }, 200);
    };

    const topicColor = (topic: string): string => {
        if (topic.includes('stderr') || topic.includes('error')) return 'text-red-400';
        if (topic.includes('stdout')) return 'text-green-400';
        if (topic.includes('task')) return 'text-yellow-400';
        if (topic.includes('agent') || topic.includes('ai')) return 'text-purple-400';
        if (topic.includes('pkg')) return 'text-cyan-400';
        return 'text-gray-400';
    };

    return (
        <div className="flex flex-col h-full bg-[#0c0c0c] text-white font-mono p-4 overflow-hidden">
            {/* Header */}
            <div className="flex items-center gap-3 mb-4 pb-3 border-b border-white/10">
                <Clock className="text-amber-400" size={20} />
                <h2 className="text-lg font-bold tracking-tight">Temporal Branch Timeline</h2>
                <span className="ml-auto text-xs text-white/30">{entries.length} events captured</span>
            </div>

            {/* Slider */}
            <div className="flex items-center gap-3 mb-4 bg-white/5 p-3 rounded-lg border border-white/5">
                <button
                    onClick={() => handleSliderChange(Math.max(0, sliderPos - 1))}
                    className="p-1.5 rounded bg-white/10 hover:bg-white/20 transition-colors"
                >
                    <ChevronLeft size={14} />
                </button>
                <input
                    type="range"
                    min={0}
                    max={Math.max(0, entries.length - 1)}
                    value={sliderPos}
                    onChange={e => handleSliderChange(parseInt(e.target.value))}
                    className="flex-1 accent-amber-400 h-1.5 cursor-pointer"
                />
                <button
                    onClick={() => handleSliderChange(Math.min(entries.length - 1, sliderPos + 1))}
                    className="p-1.5 rounded bg-white/10 hover:bg-white/20 transition-colors"
                >
                    <ChevronRight size={14} />
                </button>
                <button
                    onClick={handleReplay}
                    disabled={isReplaying || entries.length === 0}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 border border-amber-500/30 text-xs font-bold transition-all disabled:opacity-30"
                >
                    {isReplaying ? <RotateCcw size={12} className="animate-spin" /> : <Play size={12} />}
                    {isReplaying ? 'Replaying...' : 'Replay'}
                </button>
            </div>

            {/* Selected Entry Detail */}
            {selectedEntry && (
                <div className="bg-white/5 border border-white/10 rounded-lg p-4 mb-4">
                    <div className="flex items-center justify-between mb-2">
                        <span className={`text-xs font-bold uppercase tracking-widest ${topicColor(selectedEntry.topic)}`}>
                            {selectedEntry.topic}
                        </span>
                        <span className="text-[10px] text-white/30">{selectedEntry.time}</span>
                    </div>
                    <p className="text-sm text-white/70">{selectedEntry.summary}</p>
                    <div className="text-[10px] text-white/20 mt-2">
                        From: {selectedEntry.from} | Event #{selectedEntry.index + 1} of {entries.length}
                    </div>
                </div>
            )}

            {/* Event Log */}
            <div className="flex-1 overflow-y-auto space-y-1">
                {entries.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full opacity-30">
                        <Clock size={32} className="text-amber-400 mb-2" />
                        <p className="text-xs text-gray-500">Waiting for system events...</p>
                        <p className="text-[10px] text-gray-600 mt-1">Execute commands or run tasks to populate the timeline.</p>
                    </div>
                )}
                {entries.map((entry, i) => (
                    <div
                        key={entry.id}
                        onClick={() => { setSliderPos(i); setSelectedEntry(entry); }}
                        className={`flex items-center gap-3 px-3 py-1.5 rounded cursor-pointer transition-all text-xs ${
                            i === sliderPos
                                ? 'bg-amber-500/10 border border-amber-500/20'
                                : 'hover:bg-white/5 border border-transparent'
                        }`}
                    >
                        <span className="text-[10px] text-white/20 w-6 text-right">{i + 1}</span>
                        <span className={`w-2 h-2 rounded-full ${i <= sliderPos ? 'bg-amber-400' : 'bg-white/10'}`} />
                        <span className={`font-mono ${topicColor(entry.topic)}`}>{entry.topic}</span>
                        <span className="text-white/30 flex-1 truncate">{entry.summary}</span>
                        <span className="text-[10px] text-white/15">{entry.time}</span>
                    </div>
                ))}
            </div>
        </div>
    );
};
