import React, { useEffect, useState } from 'react';
import { kernel } from '../../services/kernel';
import { Envelope } from '../../types';
import { AlertOctagon, CheckCircle, AlertTriangle, Info, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface ToastMessage {
    id: string;
    title?: string;
    message: string;
    urgency: 'info' | 'success' | 'warning' | 'error' | 'panic';
}

const TOAST_COLORS = {
    info:    { bg: 'bg-[#1e293b]/90', border: 'border-blue-500',    icon: Info,          textHead: 'text-blue-400',    textBody: 'text-blue-100' },
    success: { bg: 'bg-[#064e3b]/90', border: 'border-emerald-500', icon: CheckCircle,   textHead: 'text-emerald-400', textBody: 'text-emerald-100' },
    warning: { bg: 'bg-[#451a03]/90', border: 'border-amber-500',   icon: AlertTriangle, textHead: 'text-amber-400',   textBody: 'text-amber-100' },
    error:   { bg: 'bg-[#4c0519]/90', border: 'border-red-500',     icon: AlertOctagon,  textHead: 'text-red-400',     textBody: 'text-red-100' },
    panic:   { bg: 'bg-[#4c0519]/90', border: 'border-red-500',     icon: AlertOctagon,  textHead: 'text-red-400',     textBody: 'text-red-100' },
};

export const ToastSystem: React.FC = () => {
    const [toasts, setToasts] = useState<ToastMessage[]>([]);

    useEffect(() => {
        const unsubscribe = kernel.subscribe((env: Envelope) => {
            if (env.topic === 'sys.kernel_panic') {
                const payload = env.payload as Record<string, string>;
                addToast({
                    title: 'Kernel Panic',
                    message: `${payload.subsystem}: ${payload.error}`,
                    urgency: 'panic',
                });
            }

            if (env.topic === 'sys.notify:toast') {
                const payload = env.payload as Record<string, string>;
                addToast({
                    title: payload.title,
                    message: payload.message || 'Notification',
                    urgency: (payload.urgency as ToastMessage['urgency']) || 'info',
                });
            }
        });

        // Test toast on mount (dev only)
        // addToast({ title: 'Welcome', message: 'Kernos CDE Initialized.', urgency: 'success' });

        return unsubscribe;
    }, []);

    const addToast = (toast: Omit<ToastMessage, 'id'>) => {
        const id = Math.random().toString(36).substring(7);
        setToasts(prev => [...prev, { ...toast, id }]);
    };

    const removeToast = (id: string) => {
        setToasts(prev => prev.filter(t => t.id !== id));
    };

    return (
        <div className="fixed top-4 right-4 z-[99999] flex flex-col gap-3 max-w-sm pointer-events-none perspective-[1000px]">
            <AnimatePresence mode="popLayout">
                {toasts.map(toast => (
                    <ToastItem key={toast.id} toast={toast} onRemove={removeToast} />
                ))}
            </AnimatePresence>
        </div>
    );
};

// Extracted ToastItem for individual timeout & hover management
const ToastItem: React.FC<{ toast: ToastMessage; onRemove: (id: string) => void }> = ({ toast, onRemove }) => {
    const style = TOAST_COLORS[toast.urgency] || TOAST_COLORS.info;
    const IconComponent = style.icon;
    const DURATION = 5000;
    const [isHovered, setIsHovered] = useState(false);

    useEffect(() => {
        if (isHovered) return;
        const timer = setTimeout(() => {
            onRemove(toast.id);
        }, DURATION);
        return () => clearTimeout(timer);
    }, [toast.id, onRemove, isHovered]);

    return (
        <motion.div
            layout
            initial={{ opacity: 0, x: 100, scale: 0.9, rotateX: 20 }}
            animate={{ opacity: 1, x: 0, scale: 1, rotateX: 0 }}
            exit={{ opacity: 0, scale: 0.8, transition: { duration: 0.2 } }}
            whileHover={{ scale: 1.02 }}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            className={`pointer-events-auto relative overflow-hidden backdrop-blur-2xl border border-white/10 ${style.bg} p-4 rounded-xl shadow-[0_10px_40px_rgba(0,0,0,0.5)] flex items-start gap-4`}
        >
            <div className={`mt-0.5 rounded-full bg-black/20 p-1.5 ${style.textHead}`}>
                <IconComponent size={20} />
            </div>
            
            <div className="flex-1 min-w-0 py-0.5">
                {toast.title && (
                    <h4 className={`font-bold ${style.textHead} text-[13px] mb-1 uppercase tracking-wider`}>
                        {toast.title}
                    </h4>
                )}
                <p className={`text-xs ${style.textBody} font-mono leading-relaxed line-clamp-3`}>
                    {toast.message}
                </p>
            </div>
            
            <button
                onClick={() => onRemove(toast.id)}
                className={`p-1 rounded opacity-50 hover:opacity-100 hover:bg-black/20 ${style.textHead} transition-all`}
            >
                <X size={16} />
            </button>

            {/* Timeout Progress Bar */}
            <motion.div 
                className={`absolute bottom-0 left-0 h-[3px] opacity-70 ${style.border.replace('border-', 'bg-')}`}
                initial={{ width: '100%' }}
                animate={{ width: isHovered ? '100%' : '0%' }}
                transition={{ duration: isHovered ? 0.2 : DURATION / 1000, ease: 'linear' }}
            />
        </motion.div>
    );
};
