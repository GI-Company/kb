import React, { useState, useEffect } from 'react';
import { kernel } from '../services/kernel';
import { Envelope } from '../types';
import { Play, CheckCircle, Clock, AlertCircle, Loader, Target } from 'lucide-react';

interface TaskStep {
    name: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    progress: number;
}

export const TaskRunnerApp: React.FC = () => {
    const [runId, setRunId] = useState<string | null>(null);
    const [steps, setSteps] = useState<Record<string, TaskStep>>({});
    const [isRunning, setIsRunning] = useState(false);
    const [goalInput, setGoalInput] = useState('');
    const [mode, setMode] = useState<'pipeline' | 'goal'>('goal');

    const startTask = () => {
        setIsRunning(true);
        setSteps({});
        const reqId = Math.random().toString();
        kernel.publish('task.run', { _request_id: reqId, graphId: 'build-pipeline' });
    };

    const startGoal = () => {
        if (!goalInput.trim()) return;
        setIsRunning(true);
        setSteps({});
        setRunId(null);
        const graphId = 'goal-' + Date.now();
        kernel.publish('task.run', { graphId, goal: goalInput.trim() });
        setRunId(graphId);
    };

    useEffect(() => {
        const unsub = kernel.subscribe((env: Envelope) => {
            if (env.topic === 'task.run:ack') {
                setRunId(env.payload.runId);
            }
            if (env.topic === 'task.event' && env.payload.runId === runId) {
                const { step, status, progress } = env.payload;
                setSteps(prev => ({
                    ...prev,
                    [step]: { name: step, status, progress }
                }));
            }
            if (env.topic === 'task.done' && env.payload.runId === runId) {
                setIsRunning(false);
            }
        });
        return unsub;
    }, [runId]);

    const getIcon = (status: TaskStep['status']) => {
        switch(status) {
            case 'pending': return <Clock size={16} className="text-gray-600" />;
            case 'running': return <Loader size={16} className="text-cyan-400 animate-spin" />;
            case 'completed': return <CheckCircle size={16} className="text-green-400" />;
            case 'failed': return <AlertCircle size={16} className="text-red-400" />;
        }
    };

    return (
        <div className="h-full bg-[#111115] text-white p-6 flex flex-col items-center">
            <div className="w-full max-w-md">
                <div className="mb-8 text-center">
                    <div className="text-2xl font-bold mb-2">Task Engine</div>
                    <div className="text-gray-500 text-sm">DAG Execution & Autonomous Agent</div>
                </div>

                {/* Mode Toggle */}
                <div className="flex gap-2 mb-5">
                    <button
                        onClick={() => setMode('goal')}
                        className={`flex-1 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${
                            mode === 'goal' ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30' : 'bg-white/5 text-gray-500 border border-transparent'
                        }`}
                    >
                        <Target size={14} className="inline mr-1 mb-0.5" /> Goal Mode
                    </button>
                    <button
                        onClick={() => setMode('pipeline')}
                        className={`flex-1 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${
                            mode === 'pipeline' ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30' : 'bg-white/5 text-gray-500 border border-transparent'
                        }`}
                    >
                        <Play size={14} className="inline mr-1 mb-0.5" /> Pipeline
                    </button>
                </div>

                {/* Goal Mode */}
                {mode === 'goal' && !isRunning && (
                    <div className="space-y-3">
                        <input
                            type="text"
                            value={goalInput}
                            onChange={e => setGoalInput(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && startGoal()}
                            placeholder="e.g. Set up a Node.js project with tests"
                            className="w-full bg-black/50 border border-white/10 rounded-lg px-4 py-3 text-sm text-white placeholder-gray-600 outline-none focus:border-purple-500/50 font-mono"
                        />
                        <button
                            onClick={startGoal}
                            disabled={!goalInput.trim()}
                            className="w-full py-3 bg-purple-600 hover:bg-purple-500 disabled:bg-gray-800 disabled:text-gray-600 rounded-lg font-medium flex items-center justify-center gap-2 transition-all shadow-[0_0_20px_rgba(112,0,223,0.3)]"
                        >
                            <Target size={18} /> Execute Goal Autonomously
                        </button>
                    </div>
                )}

                {/* Pipeline Mode */}
                {mode === 'pipeline' && !isRunning && !runId && (
                    <button 
                        onClick={startTask}
                        className="w-full py-3 bg-cyan-600 hover:bg-cyan-500 rounded font-medium flex items-center justify-center gap-2 transition-all shadow-[0_0_20px_rgba(8,145,178,0.3)]"
                    >
                        <Play size={18} />
                        Start Workflow
                    </button>
                )}

                <div className="space-y-3 mt-6">
                    {Object.values(steps).map((step: TaskStep) => (
                        <div key={step.name} className="bg-white/5 rounded-lg p-3 flex items-center gap-4 border border-white/5">
                            <div className="p-2 bg-black/30 rounded-full">
                                {getIcon(step.status)}
                            </div>
                            <div className="flex-1">
                                <div className="flex justify-between mb-1">
                                    <span className="text-sm font-medium capitalize">{step.name.replace('_', ' ')}</span>
                                    <span className="text-xs text-gray-500">{step.progress}%</span>
                                </div>
                                <div className="h-1 bg-white/10 rounded-full overflow-hidden">
                                    <div 
                                        className="h-full bg-cyan-500 transition-all duration-300" 
                                        style={{ width: `${step.progress}%` }}
                                    />
                                </div>
                            </div>
                        </div>
                    ))}
                </div>

                {!isRunning && runId && (
                     <button 
                     onClick={startTask}
                     className="mt-6 w-full py-2 border border-white/10 hover:bg-white/5 rounded text-gray-400 font-medium flex items-center justify-center gap-2 transition-all"
                 >
                     <RefreshIcon />
                     Rerun Pipeline
                 </button>
                )}
            </div>
        </div>
    );
};

const RefreshIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>
);