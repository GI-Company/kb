export interface Envelope<T = any> {
  topic: string;
  from: string;
  to?: string;
  payload: T;
  time: string;
}

export interface KernosError {
  _request_id: string;
  code: 'permission_denied' | 'rate_limited' | 'payload_too_large' | 'timeout' | 'resource_exceeded' | 'internal_error';
  error: string;
  details?: Record<string, any>;
}

export interface WindowState {
  id: string;
  title: string;
  appId: 'terminal' | 'editor' | 'monitor' | 'files' | 'tasks' | 'ai-chat' | 'agents' | 'applet' | 'metrics' | 'settings' | 'multi-agents' | 'cde' | 'local-model' | 'classifier' | 'timeline';
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  isMinimized: boolean;
  isMaximized: boolean;
  desktopIndex: number;
  data?: any;
}

export interface DesktopShortcut {
  id: string;
  name: string;
  icon: string; // Lucide icon name
  appletPath: string; // absolute path or known filename to compile
}

export interface FileNode {
  id: string;
  name: string;
  type: 'file' | 'directory';
  content?: string;
  /** Absent means content is plain utf8 text (the original, still-default shape). 'base64' means content is base64-encoded binary — set by curl -O/wget so a downloaded image or other binary asset round-trips byte-for-byte instead of being mangled as text. */
  encoding?: 'base64';
  children?: string[]; // IDs of children
  parentId?: string | null;
  mountSource?: string; // If present, this folder is a mount point for a remote backend
}

export type ThemeColor = 'cyan' | 'purple' | 'green' | 'orange';

export const COLORS = {
  cyan: '#00f0ff',
  purple: '#7000df',
  green: '#00ff9d',
  orange: '#ff9d00',
  dark: '#050505',
  glass: 'rgba(20, 20, 25, 0.75)',
  glassBorder: 'rgba(255, 255, 255, 0.1)'
};