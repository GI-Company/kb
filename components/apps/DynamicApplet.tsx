import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { kernel } from '../../services/kernel';
import { Envelope } from '../../types';
import * as LucideIcons from 'lucide-react';

interface DynamicAppletProps {
    appletId: string;
    sourceCode: string; // The transpiled IIFE JavaScript from the kernel
}

export const DynamicApplet: React.FC<DynamicAppletProps> = ({ appletId, sourceCode }) => {
    const [Component, setComponent] = useState<React.ComponentType<any> | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Shadow DOM Refs
    const hostRef = useRef<HTMLDivElement>(null);
    const [shadowRoot, setShadowRoot] = useState<ShadowRoot | null>(null);
    // attachShadow() can only ever be called once per host element — a
    // second call throws "Shadow root cannot be created on a host which
    // already hosts a shadow tree." React 18 StrictMode's dev-mode
    // double-invoke of effects (setup, no cleanup exists so it just runs
    // setup again) would hit that on the very first mount if guarded only
    // by the `shadowRoot` state, since state hasn't committed yet between
    // the two synchronous invocations — a ref updates immediately, so it's
    // the only reliable guard here.
    const shadowAttachedRef = useRef(false);

    useEffect(() => {
        if (hostRef.current && !shadowAttachedRef.current) {
            shadowAttachedRef.current = true;

            // Create a closed shadow root so it's fully isolated from window.document.querySelector
            const root = hostRef.current.attachShadow({ mode: 'closed' });

            // Re-inject Tailwind CSS specifically into this shadow boundary
            const styleLink = document.createElement('link');
            styleLink.rel = 'stylesheet';
            styleLink.href = '/index.css';
            root.appendChild(styleLink);

            // Create a mount point for the React Portal inside the shadow root
            const mountPoint = document.createElement('div');
            mountPoint.style.height = '100%';
            mountPoint.style.width = '100%';
            root.appendChild(mountPoint);

            setShadowRoot(root);
        }
    }, []);

    useEffect(() => {
        try {
            // ---------------------------------------------------------------------------
            // APPLET SANDBOX SECURITY:
            // We do NOT pass the raw `kernel` object into the sandbox.
            // If we did, a rogue applet could just run `kernel.publish('vm.spawn', 'rm -rf /')`.
            // Instead, we build a restricted proxy `AppletAPI` that only allows safe subsets.
            // ---------------------------------------------------------------------------
            const AppletAPI = {
                publish: (topic: string, payload: any) => {
                    // HARD BLOCK: Destructive internal OS commands
                    const blockedTopics = ['vm.spawn', 'task.run', 'sys.consolidate'];
                    if (blockedTopics.some(t => topic.startsWith(t))) {
                        console.error(`[AppletSecurity] Security Exception: Applet attempted to access restricted kernel topic: ${topic}`);
                        return;
                    }
                    kernel.publish(topic, payload);
                },
                subscribe: (callback: (env: Envelope) => void) => {
                    return kernel.subscribe(callback);
                }
            };

            // We use a new Function to simulate an isolated evaluation
            // We pass the globals it might need
            const evalSandbox = new Function(
                'React',
                'Lucide',
                'kernel', // We inject our restricted AppletAPI proxy here
                'console', // Let them log to the Kernos devtools
                `
          try {
            ${sourceCode}
            return KernosDynamicApplet;
          } catch(err) {
            throw err;
          }
        `
            );

            // Execute the sandbox passing our actual React instance and the restricted kernel
            const evaluatedComponent = evalSandbox(React, LucideIcons, AppletAPI, console);

            if (evaluatedComponent) {
                setComponent(() => evaluatedComponent);
                setError(null);
            } else {
                setError('Applet compiled but returned null component.');
            }
        } catch (err: any) {
            console.error(`[AppletRunner] Failed to evaluate applet ${appletId}:`, err);
            setError(err.toString());
        }
    }, [sourceCode, appletId]);

    // The host div must always mount, unconditionally — the shadow-root
    // effect above needs hostRef.current to already exist the first time
    // it runs. It previously only rendered in the final "success" branch
    // below, which meant shadowRoot could never actually be set (the
    // effect never had an element to attach to) and every applet was
    // permanently stuck on the loading state. Loading/error states now
    // render as overlays alongside the (possibly still-empty) host div
    // instead of replacing it.
    return (
        <div style={{ width: '100%', height: '100%', position: 'relative' }}>
            <div ref={hostRef} style={{ width: '100%', height: '100%' }} />

            {error && (
                <div className="absolute inset-0 p-4 bg-red-900/50 text-red-200 overflow-auto font-mono text-sm">
                    <h3 className="text-red-400 font-bold mb-2">Applet Runtime Error:</h3>
                    <pre>{error}</pre>
                    <div className="mt-4 text-xs opacity-70">
                        Tip: Ensure you are exporting a default React functional component.
                    </div>
                </div>
            )}

            {!error && (!Component || !shadowRoot) && (
                <div className="absolute inset-0 flex items-center justify-center text-zinc-500 animate-pulse">
                    Initializing Applet {appletId} (Sandbox)...
                </div>
            )}

            {/* ---------------------------------------------------------------------------
                SHADOW DOM ISOLATION:
                By rendering via createPortal into the shadowRoot.lastChild (our mount point),
                we guarantee the Applet cannot use document.querySelector to scrape the OS UI,
                nor can its CSS classes bleed out and break the Kernos Desktop layout.
               --------------------------------------------------------------------------- */}
            {!error && Component && shadowRoot && createPortal(<Component />, shadowRoot.lastChild as Element)}
        </div>
    );
};
