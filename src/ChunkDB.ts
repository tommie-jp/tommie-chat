import { prof } from "./Profiler";

const DB_VERSION = 1;
const STORE_NAME = "chunks";

function openDB(userId: string): Promise<IDBDatabase> {
    const dbName = `mmo_chunks_${userId}`;
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: "key" });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export interface ChunkRecord {
    key: string;       // "cx_cz"
    cells: Uint8Array; // chunkSize*chunkSize*6 bytes
    hash: string;      // FNV-1a 64bit hash (decimal string)
}

export async function loadAllChunks(userId: string): Promise<ChunkRecord[]> {
    const _end = prof("ChunkDB.loadAllChunks");
    try {
    const db = await openDB(userId);
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const results: ChunkRecord[] = [];
        const req = store.openCursor();
        req.onsuccess = () => {
            const cursor = req.result;
            if (cursor) {
                const val = cursor.value as { key: string; cells: ArrayBuffer | Uint8Array; hash: string };
                results.push({
                    key: val.key,
                    cells: new Uint8Array(val.cells),
                    hash: val.hash ?? "0",
                });
                cursor.continue();
            } else {
                resolve(results);
            }
        };
        req.onerror = () => reject(req.error);
    });
    } finally { _end(); }
}

export async function saveChunks(userId: string, records: ChunkRecord[]): Promise<void> {
    const _end = prof("ChunkDB.saveChunks");
    try {
    if (records.length === 0) return;
    const db = await openDB(userId);
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        for (const rec of records) {
            store.put({ key: rec.key, cells: rec.cells, hash: rec.hash });
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    } finally { _end(); }
}
