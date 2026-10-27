const DB_NAME = "mnq-replay-bars";
const STORE = "packs";

function canUseIdb(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB failed"));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = openDb().catch((error: unknown) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

/** Cached response text for a history pack. Misses and private-mode failures return null. */
export async function readPackCache(key: string): Promise<string | null> {
  if (!canUseIdb()) return null;
  try {
    const database = await db();
    return await new Promise((resolve) => {
      const tx = database.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).get(key);
      request.onsuccess = () => {
        resolve(typeof request.result === "string" ? request.result : null);
      };
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function writePackCache(key: string, text: string): Promise<void> {
  if (!canUseIdb()) return;
  try {
    const database = await db();
    await new Promise<void>((resolve) => {
      const tx = database.transaction(STORE, "readwrite");
      const request = tx.objectStore(STORE).put(text, key);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
    });
  } catch {
    // Ignore quota and private-mode failures. The network copy still loads.
  }
}
