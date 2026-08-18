// Requests persistent storage (Storage Manager API) so an installed
// instance's VFS, trained local models, and chat history aren't subject to
// the browser's origin-eviction-under-pressure policy — the same policy
// that governs an ordinary, never-visited tab's cache. An app whose whole
// pitch is local-first persistence shouldn't lose it exactly like one.
//
// Silent on Chrome/Edge: persist() is granted or refused based on the
// browser's own site-engagement heuristics, with no permission prompt
// shown. Firefox may prompt the user directly. Either way this is a
// best-effort request, not a guarantee — there is nothing more to do if it
// comes back false beyond trying again on a later visit once engagement
// heuristics catch up, which calling this on every desktop entry already
// does for free.

export interface PersistenceStatus {
  /** False in browsers without the Storage Manager API (older Safari) — nothing to request or report. */
  supported: boolean;
  persisted: boolean;
}

export async function ensurePersistentStorage(): Promise<PersistenceStatus> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist || !navigator.storage?.persisted) {
    return { supported: false, persisted: false };
  }
  const already = await navigator.storage.persisted();
  if (already) return { supported: true, persisted: true };
  const granted = await navigator.storage.persist();
  return { supported: true, persisted: granted };
}

export interface StorageEstimate {
  usageBytes: number;
  quotaBytes: number;
}

/** For a Settings panel to show "how much of my device this is using" — null wherever the API isn't available or doesn't report usable numbers. */
export async function getStorageEstimate(): Promise<StorageEstimate | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  if (usage === undefined || quota === undefined) return null;
  return { usageBytes: usage, quotaBytes: quota };
}
