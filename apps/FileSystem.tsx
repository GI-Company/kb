import React, { useState, useEffect, useCallback, useRef } from 'react';
import { vfs, registerMountHandle } from '../lib/vfs';
import { useOS } from '../store';
import { FileNode } from '../types';
import { getCurrentUserId } from '../lib/auth';
import { kernel } from '../services/kernel';
import { Folder, FileText, ChevronRight, Home, RefreshCw, FilePlus, FolderPlus, Trash2, Edit2, Cloud, Upload, Share2, HardDrive } from 'lucide-react';

// Caps on a recursive directory mount so an accidental pick of something
// huge (a whole home folder, node_modules) can't hang the tab — a mount is
// meant for "a project folder", not an arbitrary disk subtree.
const MOUNT_MAX_FILES = 500;
const MOUNT_MAX_DEPTH = 8;

function toast(title: string, message: string, urgency: 'info' | 'success' | 'warning' | 'error' = 'info') {
  kernel.publish('sys.notify:toast', { title, message, urgency });
}

export const FileSystemApp: React.FC = () => {
  const [files, setFiles] = useState<FileNode[]>([]);
  const [pathStack, setPathStack] = useState<string[]>(['home']);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [userId, setUserId] = useState('guest');
  const { openWindow } = useOS();

  useEffect(() => {
    getCurrentUserId().then(setUserId);
  }, []);

  const currentPath = pathStack[pathStack.length - 1];
  const selectedFile = files.find(f => f.id === selectedId);

  const refresh = useCallback(() => {
    vfs.list(currentPath, userId).then(setFiles);
  }, [currentPath, userId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const navigateTo = (id: string) => {
    setPathStack(prev => [...prev, id]);
    setSelectedId(null);
  };

  const navigateUp = () => {
    if (pathStack.length > 1) {
      setPathStack(prev => prev.slice(0, -1));
      setSelectedId(null);
    }
  };

  const navigateToBreadcrumb = (index: number) => {
    setPathStack(prev => prev.slice(0, index + 1));
    setSelectedId(null);
  };

  const handleDoubleClick = (file: FileNode) => {
    if (file.type === 'directory') {
      navigateTo(file.id);
    } else {
      openWindow('editor', file.name, { fileId: file.id, fileName: file.name });
    }
  };

  const handleCreate = async (type: 'file' | 'directory') => {
    const name = prompt(`Enter ${type} name:`);
    if (name) {
      await vfs.create(currentPath, name, type, userId);
      refresh();
    }
  };

  const handleRename = async () => {
    if (!selectedId) return;
    const file = files.find(f => f.id === selectedId);
    if (!file) return;
    const newName = prompt(`Rename ${file.name} to:`, file.name);
    if (newName && newName !== file.name) {
      await vfs.rename(selectedId, newName, userId);
      refresh();
    }
  };

  const handleDelete = async () => {
    if (!selectedId) return;
    if (confirm('Delete selected item?')) {
      await vfs.remove(selectedId, userId);
      setSelectedId(null);
      refresh();
    }
  };

  // Mobile (and desktop) file import: reads picked files as text and writes
  // them into the current VFS directory. Binary files come through as
  // whatever .text() decodes them to — the VFS only ever stores strings, the
  // same constraint every other app in this tree (Editor, CDE) already lives
  // with, so this doesn't introduce a new one.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handleImportFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked: File[] = Array.from(e.target.files ?? []);
    e.target.value = ''; // allow re-picking the same file(s) next time
    if (picked.length === 0) return;

    let imported = 0;
    const failed: string[] = [];
    for (const file of picked) {
      try {
        const content = await file.text();
        await vfs.create(currentPath, file.name, 'file', userId, content);
        imported++;
      } catch {
        failed.push(file.name);
      }
    }
    refresh();
    if (imported > 0) toast('Imported', `${imported} file${imported === 1 ? '' : 's'} added to ${currentPath}.`, 'success');
    if (failed.length > 0) toast('Import failed', failed.join(', '), 'error');
  };

  // Web Share export: shares the selected file's content out to whatever the
  // OS share sheet offers (Files, Mail, another app...). Falls back to a
  // text-only share when the browser can't share Files (older Android/iOS,
  // or desktop browsers that support navigator.share but not file sharing),
  // and to a plain toast when Web Share isn't available at all — desktop
  // Chrome/Firefox mostly, and any non-HTTPS context.
  const canShareFiles = typeof navigator !== 'undefined' && !!navigator.canShare;
  const handleShare = async () => {
    const file = selectedFile;
    if (!file || file.type !== 'file') return;

    try {
      const content = await vfs.read(file.id, userId);
      if (navigator.share) {
        const shareFile = new File([content], file.name, { type: 'text/plain' });
        if (canShareFiles && navigator.canShare!({ files: [shareFile] })) {
          await navigator.share({ files: [shareFile], title: file.name });
          return;
        }
        await navigator.share({ title: file.name, text: content });
        return;
      }
      toast('Sharing unavailable', "This browser doesn't support the Web Share API — try a mobile browser, or copy the file's content from the editor instead.", 'warning');
    } catch (err: any) {
      if (err?.name === 'AbortError') return; // user dismissed the share sheet
      toast('Share failed', err?.message || String(err), 'error');
    }
  };

  // Desktop-only optional mount: picks a real directory and imports its
  // text files into the VFS, tagged with mountSource so the grid shows it
  // as "Connected". Registers each file's live handle with vfs.ts so a save
  // from anywhere (Editor, CDE, terminal `write`) writes through to disk
  // for the rest of this session — see lib/vfs.ts's writeThroughIfMounted
  // for why that's session-only rather than persisted.
  const isFsaSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  const walkAndImport = async (
    dirHandle: FileSystemDirectoryHandle,
    vfsParentId: string,
    mountTag: string | undefined,
    depth: number,
    counter: { imported: number; skipped: number }
  ) => {
    if (depth > MOUNT_MAX_DEPTH) return;
    for await (const entry of (dirHandle as any).values() as AsyncIterable<FileSystemHandle>) {
      if (counter.imported >= MOUNT_MAX_FILES) return;
      if (entry.kind === 'file') {
        try {
          const fileHandle = entry as FileSystemFileHandle;
          const file = await fileHandle.getFile();
          const content = await file.text();
          const node = await vfs.create(vfsParentId, file.name, 'file', userId, content);
          registerMountHandle(node.id, fileHandle);
          counter.imported++;
        } catch {
          counter.skipped++;
        }
      } else if (entry.kind === 'directory') {
        const subDir = await vfs.create(vfsParentId, entry.name, 'directory', userId);
        await walkAndImport(entry as FileSystemDirectoryHandle, subDir.id, undefined, depth + 1, counter);
      }
    }
  };

  const handleMount = async () => {
    try {
      const dirHandle = await (window as any).showDirectoryPicker();
      const mountDir = await vfs.create(currentPath, dirHandle.name, 'directory', userId, '', dirHandle.name);
      const counter = { imported: 0, skipped: 0 };
      await walkAndImport(dirHandle, mountDir.id, dirHandle.name, 0, counter);
      refresh();
      const truncated = counter.imported >= MOUNT_MAX_FILES ? ` (stopped at ${MOUNT_MAX_FILES} files — pick a smaller folder for a full mount)` : '';
      toast('Mounted', `"${dirHandle.name}": ${counter.imported} file${counter.imported === 1 ? '' : 's'} imported${counter.skipped ? `, ${counter.skipped} skipped` : ''}.${truncated}`, 'success');
    } catch (err: any) {
      if (err?.name === 'AbortError') return; // user dismissed the picker
      toast('Mount failed', err?.message || String(err), 'error');
    }
  };

  return (
    <div className="h-full bg-[#18181b] text-gray-200 flex flex-col">
      {/* Breadcrumb Toolbar */}
      <div data-tour="fs-toolbar" className="h-10 border-b border-white/5 flex items-center px-4 gap-1 text-sm bg-white/5 overflow-x-auto">
        <button onClick={() => setPathStack(['home'])} className="p-1 hover:text-white text-gray-400 flex-shrink-0"><Home size={14} /></button>
        {pathStack.map((segment, i) => (
          <React.Fragment key={i}>
            <ChevronRight size={12} className="text-gray-600 flex-shrink-0" />
            <button
              onClick={() => navigateToBreadcrumb(i)}
              className={`font-mono text-xs px-1 py-0.5 rounded hover:bg-white/10 flex-shrink-0 ${
                i === pathStack.length - 1 ? 'text-cyan-400 font-bold' : 'text-gray-400'
              }`}
            >
              {segment}
            </button>
          </React.Fragment>
        ))}

        <div className="flex-1" />
        <input ref={fileInputRef} type="file" multiple onChange={handleImportFiles} className="hidden" />
        <button onClick={() => fileInputRef.current?.click()} className="p-1.5 hover:bg-white/10 rounded text-gray-400 flex-shrink-0" title="Import files"><Upload size={14}/></button>
        {isFsaSupported && (
          <button onClick={handleMount} className="p-1.5 hover:bg-white/10 rounded text-gray-400 flex-shrink-0" title="Mount a real folder (this session only)"><HardDrive size={14}/></button>
        )}
        {selectedFile?.type === 'file' && (
          <button onClick={handleShare} className="p-1.5 hover:bg-white/10 rounded text-gray-400 flex-shrink-0" title="Share"><Share2 size={14}/></button>
        )}
        <div className="w-px h-4 bg-white/10 mx-1" />
        <button onClick={() => handleCreate('file')} className="p-1.5 hover:bg-white/10 rounded text-gray-400 flex-shrink-0" title="New File"><FilePlus size={14}/></button>
        <button onClick={() => handleCreate('directory')} className="p-1.5 hover:bg-white/10 rounded text-gray-400 flex-shrink-0" title="New Folder"><FolderPlus size={14}/></button>
        <button onClick={handleRename} className="p-1.5 hover:bg-white/10 rounded text-gray-400 flex-shrink-0" title="Rename"><Edit2 size={14}/></button>
        <button onClick={handleDelete} className="p-1.5 hover:bg-red-500/20 text-gray-400 hover:text-red-400 rounded flex-shrink-0" title="Delete"><Trash2 size={14}/></button>
        <div className="w-px h-4 bg-white/10 mx-1" />
        <button onClick={refresh} className="p-1.5 hover:bg-white/10 rounded text-gray-400 flex-shrink-0"><RefreshCw size={14}/></button>
      </div>

      {/* Grid */}
      <div data-tour="fs-grid" className="p-4 grid grid-cols-4 gap-4 overflow-y-auto flex-1">
        {pathStack.length > 1 && (
          <button
            onClick={navigateUp}
            className="flex flex-col items-center justify-center p-4 rounded border border-transparent hover:bg-white/5 text-gray-500"
          >
            <Folder size={32} className="text-gray-600" />
            <span className="mt-2 text-xs">..</span>
          </button>
        )}
        {files.map(file => {
          const isMount = !!file.mountSource;
          return (
            <button
              key={file.id}
              onClick={() => setSelectedId(file.id)}
              onDoubleClick={() => handleDoubleClick(file)}
              className={`
                flex flex-col items-center justify-center p-4 rounded border transition-colors group relative
                ${selectedId === file.id ? 'bg-cyan-500/10 border-cyan-500/50 text-cyan-100' : 'bg-white/5 border-transparent hover:bg-white/10 text-gray-400'}
              `}
            >
              {file.type === 'directory'
                ? (isMount ? <Cloud size={32} className={selectedId === file.id ? 'text-cyan-400' : 'text-blue-400 group-hover:text-blue-300'} /> : <Folder size={32} className={selectedId === file.id ? 'text-cyan-400' : 'text-yellow-500 group-hover:text-yellow-400'} />)
                : <FileText size={32} className={selectedId === file.id ? 'text-cyan-400' : 'text-gray-500 group-hover:text-gray-300'} />
              }
              <span className="mt-2 text-xs truncate w-full text-center select-none flex items-center justify-center gap-1">
                {file.name}
                {isMount && <span className="w-1.5 h-1.5 rounded-full bg-green-500" title="Connected"></span>}
              </span>
            </button>
          );
        })}
      </div>
      <div className="h-6 bg-[#0f0f13] border-t border-white/5 px-2 text-[10px] text-gray-600 flex items-center justify-between">
        <span>{files.length} items</span>
        <span>{selectedId ? `Selected: ${selectedId}` : 'Ready'}</span>
      </div>
    </div>
  );
};
