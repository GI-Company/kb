import React, { createContext, useContext, useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  divider?: boolean;
  danger?: boolean;
}

interface ContextMenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

interface ContextMenuContextType {
  showMenu: (e: React.MouseEvent, items: MenuItem[]) => void;
  hideMenu: () => void;
}

const ContextMenuContext = createContext<ContextMenuContextType | null>(null);

export const useContextMenu = () => {
  const ctx = useContext(ContextMenuContext);
  if (!ctx) throw new Error('useContextMenu must be used within a ContextMenuProvider');
  return ctx;
};

export const ContextMenuProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  useEffect(() => {
    const handleGlobalClick = () => setMenu(null);
    const handleGlobalContext = (e: MouseEvent) => {
      // Prevent default browser menu everywhere in the app
      // unless we explicitly allow it (e.g. text selection in specific places)
      if ((e.target as HTMLElement).tagName !== 'TEXTAREA' && (e.target as HTMLElement).tagName !== 'INPUT') {
        e.preventDefault();
      }
      setMenu(null);
    };

    window.addEventListener('click', handleGlobalClick);
    window.addEventListener('contextmenu', handleGlobalContext);

    return () => {
      window.removeEventListener('click', handleGlobalClick);
      window.removeEventListener('contextmenu', handleGlobalContext);
    };
  }, []);

  const showMenu = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Boundary collision detection
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const MENU_WIDTH = 200; // estimated
    const MENU_HEIGHT = items.length * 36; // estimated

    let x = e.clientX;
    let y = e.clientY;

    if (x + MENU_WIDTH > vw) x = vw - MENU_WIDTH - 10;
    if (y + MENU_HEIGHT > vh) y = vh - MENU_HEIGHT - 10;

    setMenu({ x, y, items });
  };

  const hideMenu = () => setMenu(null);

  return (
    <ContextMenuContext.Provider value={{ showMenu, hideMenu }}>
      {children}
      
      <AnimatePresence>
        {menu && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, filter: 'blur(4px)' }}
            animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, scale: 0.95, filter: 'blur(4px)', transition: { duration: 0.1 } }}
            transition={{ type: 'spring', damping: 25, stiffness: 400 }}
            className="fixed z-[99999] bg-[#161b22]/95 backdrop-blur-xl border border-white/10 rounded-xl shadow-2xl shadow-black overflow-hidden min-w-[180px] p-1.5"
            style={{ left: menu.x, top: menu.y }}
            onContextMenu={e => e.preventDefault()}
          >
            {menu.items.map((item, i) => {
              if (item.divider) {
                return <div key={i} className="h-px w-full bg-white/5 my-1" />;
              }
              return (
                <button
                  key={i}
                  onClick={(e) => {
                    e.stopPropagation();
                    item.onClick();
                    hideMenu();
                  }}
                  className={`w-full flex items-center gap-3 px-3 py-2 text-[11px] font-medium tracking-wide rounded-lg transition-colors text-left ${
                    item.danger 
                      ? 'text-red-400 hover:bg-red-500/15' 
                      : 'text-gray-300 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  {item.icon && <span className="opacity-80">{item.icon}</span>}
                  {item.label}
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </ContextMenuContext.Provider>
  );
};
