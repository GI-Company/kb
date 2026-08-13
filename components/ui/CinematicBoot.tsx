import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';

export const CinematicBoot: React.FC<{ onComplete: () => void }> = ({ onComplete }) => {
  const [lines, setLines] = useState<string[]>([]);
  const [phase, setPhase] = useState<'init' | 'memtest' | 'loading' | 'done'>('init');
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let timeout: NodeJS.Timeout;
    let isMounted = true;

    const addLine = (text: string, delay: number) => {
      return new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          if (isMounted) {
            setLines((prev) => [...prev, text]);
            resolve();
          }
        }, delay);
      });
    };

    const runSequence = async () => {
      // Phase 1: BIOS Init
      await addLine('KERNOS UEFI v1.0.4.52 (c) 2026', 100);
      await addLine('CPU: Virtual Neural Processor x86_64 @ 4.2GHz', 200);
      await addLine('MEM: 65536 OK', 100);
      await addLine('Initializing root message bus...', 150);
      await addLine('OK', 50);

      setPhase('memtest');
      
      // Fast scrolling hex for memory test
      for (let i = 0; i < 15; i++) {
        const hex1 = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
        const hex2 = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
        await addLine(`[${hex1}] Testing memory block 0x${hex2} ... OK`, 20);
      }

      setPhase('loading');
      await addLine('', 100);
      
      const modules = [
        'Zero-Trust Auth Layer',
        'Semantic VFS Node',
        'P2P WebRTC Gateway',
        'Inference Engine (LM Studio)',
        'Agentic Task Scheduler',
        'CDE Shadow Environment'
      ];

      for (let i = 0; i < modules.length; i++) {
        await addLine(`Mounting ${modules[i]}...`, 150);
        setProgress(((i + 1) / modules.length) * 100);
        await addLine(`  -> [OK]`, 50);
      }

      await addLine('', 100);
      await addLine('System Ready.', 200);
      await addLine('Starting pre-ignition sequence...', 100);

      setPhase('done');
      
      timeout = setTimeout(() => {
        if (isMounted) onComplete();
      }, 800);
    };

    runSequence();

    return () => {
      isMounted = false;
      clearTimeout(timeout);
    };
  }, [onComplete]);

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.05, filter: 'blur(10px)', transition: { duration: 0.8, ease: 'easeOut' } }}
      className="w-screen h-screen bg-[#020202] flex flex-col items-center justify-center overflow-hidden font-mono selection:bg-cyan-500/30"
    >
      <div className="w-full max-w-3xl px-8 relative z-10">
        
        {/* Boot Logo */}
        <motion.div 
          animate={phase === 'done' ? { opacity: 0, y: -20, transition: { duration: 0.5 } } : { opacity: 1, y: 0 }}
          className="text-center mb-8"
        >
          <h1 className="text-6xl font-black text-white/95 tracking-tighter">
            KERN<span className="text-cyan-500">O</span>S
          </h1>
          <div className="h-px w-32 bg-gradient-to-r from-transparent via-cyan-500 to-transparent mx-auto mt-4" />
        </motion.div>

        {/* Terminal Output */}
        <div className="h-64 overflow-hidden relative">
          <div className="absolute bottom-0 left-0 w-full flex flex-col justify-end">
            {lines.map((line, i) => {
              const op = Math.max(0.1, 1 - (lines.length - i) * 0.1);
              return (
                <div
                  key={i}
                  style={{ opacity: op }}
                  className={`text-[11px] leading-relaxed tracking-wider ${
                    line.includes('[OK]') || line.includes('OK') ? 'text-green-500/80' :
                    line.includes('Error') ? 'text-red-500/80' :
                    'text-cyan-500/60'
                  }`}
                >
                  {line || '\u00A0'}
                </div>
              );
            })}
            {phase !== 'done' && (
              <div className="text-white mt-1 animate-pulse text-[11px]">_</div>
            )}
          </div>
        </div>

        {/* Progress Bar */}
        <motion.div 
          animate={phase === 'done' ? { opacity: 0, scaleX: 0, transition: { duration: 0.4 } } : { opacity: 1, scaleX: 1 }}
          className="mt-8 h-[2px] w-full bg-white/5 relative overflow-hidden flex items-center"
        >
          <motion.div
            className="absolute left-0 top-0 h-full bg-cyan-500 shadow-[0_0_15px_rgba(0,240,255,0.8)]"
            initial={{ width: 0 }}
            animate={{ width: `${progress}%` }}
            transition={{ ease: 'linear', duration: 0.2 }}
          />
        </motion.div>
        
        {/* Helper Hint */}
        <motion.div 
          animate={phase === 'done' ? { opacity: 0 } : { opacity: 0.4 }}
          className="text-center mt-6 text-[10px] text-gray-400 font-sans tracking-widest uppercase"
        >
          Right-click to interrupt and enter BIOS
        </motion.div>
      </div>

      {/* Background Grid Scanline Effect */}
      <div 
        className="absolute inset-0 pointer-events-none opacity-10 mix-blend-screen"
        style={{
          backgroundImage: `repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0, 240, 255, 0.1) 2px, rgba(0, 240, 255, 0.1) 4px)`,
          backgroundSize: '100% 4px'
        }}
      />
    </motion.div>
  );
};
