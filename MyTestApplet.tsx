import React, { useState } from 'react';
import * as Lucide from 'lucide-react';

export default function MyTestApplet() {
  const [count, setCount] = useState(0);

  return (
    <div className="p-4 text-white font-sans flex flex-col items-center justify-center h-full">
      <Lucide.Sparkles className="text-pink-400 mb-4" size={32} />
      <h2 className="text-xl font-bold mb-2">Hello from MyTestApplet!</h2>
      <p className="text-slate-400 mb-4">This is a dynamically compiled React Applet.</p>
      
      <button 
        onClick={() => setCount(c => c + 1)}
        className="px-4 py-2 bg-pink-500/20 hover:bg-pink-500/40 text-pink-300 rounded transition-colors"
      >
        Clicked {count} times
      </button>
    </div>
  );
}
