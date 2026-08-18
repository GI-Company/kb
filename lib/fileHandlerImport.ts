// The client-side half of manifest.webmanifest's file_handlers entry — an
// OS "Open with Kernos OS" on a real file delivers it here as a
// FileSystemFileHandle via the Launch Handler API (window.launchQueue),
// not a URL. App.tsx's setConsumer callback is thin glue over this;
// extracted so the actual import logic is testable without needing a real
// OS-triggered launch event, which nothing in a test (or this page's own
// JS) can simulate — launchQueue exposes no way to fire a launch itself.

import { vfs } from './vfs';

export interface ImportedLaunchFile {
  name: string;
  fileId: string;
}

/** Reads a launched file's text content and lands it in the VFS root as a new file, ready to open in Editor. */
export async function importLaunchedFile(handle: FileSystemFileHandle, userId: string): Promise<ImportedLaunchFile> {
  const file = await handle.getFile();
  const text = await file.text();
  const created = await vfs.create('home', file.name, 'file', userId, text);
  return { name: file.name, fileId: created.id };
}
