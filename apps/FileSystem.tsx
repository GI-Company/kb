import React, { useState, useEffect, useCallback } from 'react';
import { vfs } from '../lib/vfs';
import { useOS } from '../store';
import { FileNode } from '../types';
import { getCurrentUserId } from '../lib/auth';
import { Folder, FileText, ChevronRight, Home, RefreshCw, FilePlus, FolderPlus, Trash2, Edit2, Cloud } from 'lucide-react';

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
