import React, { useEffect, useState, useRef } from 'react';
import { kernel } from '../../services/kernel';
import { Envelope } from '../../types';

export const AudioSystem: React.FC = () => {
    const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
    const [preferredVoice, setPreferredVoice] = useState<SpeechSynthesisVoice | null>(null);
    const synthRef = useRef(window.speechSynthesis);

    useEffect(() => {
        // Load available voices. Browsers load these asynchronously.
        const loadVoices = () => {
            const availableVoices = synthRef.current.getVoices();
            setVoices(availableVoices);

            // Try to find a premium English synthetic voice
            // macOS: Samantha, Siri, Daniel
            // Windows: Microsoft Zira, Mark
            // Chrome: Google US English
            const premiumVoices = ['Google US English', 'Samantha', 'Microsoft Zira', 'Daniel'];

            for (const pref of premiumVoices) {
                const match = availableVoices.find(v => v.name.includes(pref) && v.lang.startsWith('en'));
                if (match) {
                    setPreferredVoice(match);
                    break;
                }
            }

            // Fallback to the first English voice
            if (!preferredVoice && availableVoices.length > 0) {
                const enVoice = availableVoices.find(v => v.lang.startsWith('en'));
                if (enVoice) setPreferredVoice(enVoice);
            }
        };

        loadVoices();
        synthRef.current.onvoiceschanged = loadVoices;

        return () => {
            synthRef.current.onvoiceschanged = null;
        };
    }, []);

    // The Speak Function
    const speak = (text: string, priority: 'normal' | 'urgent' = 'normal') => {
        if (!synthRef.current) return;

        // Strip markdown and thinking tokens for cleaner audio
        const cleanText = text
            .replace(/<think>[\s\S]*?<\/think>/g, '') // Remove internal Qwen monologues
            .replace(/[*_#`]/g, '') // Remove basic markdown
            .trim();

        if (!cleanText) return;

        // If urgent, cut off whatever is currently speaking
        if (priority === 'urgent') {
            synthRef.current.cancel();
        }

        const utterance = new SpeechSynthesisUtterance(cleanText);
        if (preferredVoice) {
            utterance.voice = preferredVoice;
        }

        // OS Voice Profile Tuning
        utterance.rate = 1.05; // Slightly faster than human
        utterance.pitch = 0.95; // Slightly deeper/calmer 

        synthRef.current.speak(utterance);
    };

    // Bind Voice to Kernel Message Bus
    useEffect(() => {
        const unsub = kernel.subscribe((env: Envelope) => {

            // 1. AI Conversational Output
            if (env.topic === 'ai.done') {
                // If it's a long message, maybe just summarize or read the first sentence
                let msg = env.payload.full_message || '';
                if (msg.length > 300) {
                    // Just read the first paragraph to avoid overwhelming the user
                    msg = msg.split('\n')[0];
                }
                speak(msg);
            }

            // 2. Task Engine Approvals (The Architect)
            if (env.topic === 'task.run:approved') {
                speak(`Execution Graph via ${env.payload.agent} approved. Safety checks passed.`);
            }

            // 3. Task Engine Denials
            if (env.topic === 'task.run:failed' && env.payload.error?.includes('unsafe')) {
                speak(`Action halted. The Architect determined this graph is fundamentally unsafe.`, 'urgent');
            }

            // 4. RLHF Nightly Consolidation
            if (env.topic === 'sys.consolidate:done') {
                speak(`Synaptic weights updated successfully. Learning cycle complete.`);
            }

            // 5. Applet Compiler 
            if (env.topic === 'applet.compile:success') {
                speak(`Applet ${env.payload.appletId} compiled natively and injected into process tree.`);
            }

        });

        return unsub;
    }, [preferredVoice]); // Re-bind if language changes

    // The AudioSystem has no visual UI footprint, it just exists in the React tree.
    return null;
};
