import React, { useState, useEffect } from 'react';
import * as Lucide from 'lucide-react';
import { kernel } from './services/kernel';
import { Envelope } from './types';

export default function Cartographer() {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<any[]>([]);
    const [isSearching, setIsSearching] = useState(false);

    useEffect(() => {
        // Listen for semantic responses from the OS Kernel
        const unsub = kernel.subscribe((env: Envelope) => {
            if (env.topic === 'vfs:semantic:result') {
                const payload = env.payload;
                if (payload.results) {
                    setResults(payload.results);
                } else {
                    setResults([]);
                }
                setIsSearching(false);
            }
        });
        return unsub;
    }, []);

    const handleSearch = () => {
        if (!query.trim()) return;

        setIsSearching(true);
        // Request semantic search from the Nomic Vector Database embedded in the Go Kernel
        kernel.publish('vfs:semantic', {
            query: query,
            limit: 5 // Get top 5 semantically similar code chunks
        });
    };

    const getHeatColor = (similarity: number) => {
        if (similarity > 0.8) return 'text-purple-400 bg-purple-500/20';
        if (similarity > 0.6) return 'text-pink-400 bg-pink-500/20';
        if (similarity > 0.4) return 'text-orange-400 bg-orange-500/20';
        return 'text-blue-400 bg-blue-500/20';
    };

    return (
        <div className="flex flex-col h-full bg-[#1e1e1e] text-gray-300 font-sans p-4 overflow-hidden">

            {/* Header */}
            <div className="flex items-center gap-3 mb-6 pb-4 border-b border-white/10">
                <div className="p-2 bg-gradient-to-br from-purple-500/20 to-pink-500/20 rounded border border-purple-500/30 shadow-[0_0_15px_rgba(168,85,247,0.2)]">
                    <Lucide.Map className="text-purple-400" size={24} />
                </div>
                <div>
                    <h2 className="text-xl font-bold text-white tracking-wide">Semantic Cartographer</h2>
                    <p className="text-xs text-gray-500">Native Applet • Nomic Latent Space Visualizer</p>
                </div>
            </div>

            {/* Query Bar */}
            <div className="flex gap-2 mb-6">
                <div className="relative flex-1">
                    <Lucide.Telescope className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" size={16} />
                    <input
                        type="text"
                        className="w-full bg-[#252526] border border-white/10 rounded px-10 py-2 text-sm focus:outline-none focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/50 transition-all placeholder-gray-600"
                        placeholder="Map concept... (e.g. 'WebSocket Routing', 'User Auth')"
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleSearch()}
                    />
                </div>
                <button
                    onClick={handleSearch}
                    disabled={isSearching || !query}
                    className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded font-medium text-sm transition-colors disabled:opacity-50"
                >
                    {isSearching ? <Lucide.Loader className="animate-spin" size={16} /> : <Lucide.Search size={16} />}
                    Scan
                </button>
            </div>

            {/* Latent Space Results */}
            <div className="flex-1 overflow-auto rounded border border-white/5 bg-[#1a1a1c] p-4 relative">
                {results.length === 0 && !isSearching ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-600">
                        <Lucide.Wifi className="mb-2 opacity-50" size={32} />
                        <p className="text-sm">Enter a query to triangulate files in Latent Semantic Space.</p>
                    </div>
                ) : (
                    <div className="space-y-4">
                        {results.map((res: any, i: number) => (
                            <div
                                key={i}
                                className="p-3 bg-white/5 border border-white/10 rounded hover:border-white/20 transition-colors group"
                            >
                                <div className="flex justify-between items-start mb-2">
                                    <div className="flex items-center gap-2">
                                        <Lucide.FileCode size={14} className="text-gray-400 group-hover:text-purple-400 transition-colors" />
                                        <span className="font-mono text-sm text-gray-200">{res.name}</span>
                                    </div>

                                    {/* Semantic Density Metric */}
                                    <div className={`text-xs px-2 py-0.5 rounded-full font-mono flex items-center gap-1 ${getHeatColor(res.similarity)}`}>
                                        <Lucide.Flame size={10} />
                                        {(res.similarity * 100).toFixed(1)}% Match
                                    </div>
                                </div>

                                <div className="w-full bg-black/50 overflow-hidden relative border border-white/5 rounded">
                                    <pre className="text-xs p-3 text-gray-400 font-mono whitespace-pre-wrap leading-relaxed max-h-32 overflow-y-auto">
                                        {res.content}
                                    </pre>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

        </div>
    );
}
