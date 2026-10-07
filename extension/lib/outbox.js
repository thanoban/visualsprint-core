/** Durable media outbox. Server acknowledgment is required before deletion. */
const MAX_PENDING_BYTES = 64 * 1024 * 1024;
let opening;

function database() {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("vs-capture-outbox", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("media", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return opening;
}

async function transaction(mode, operation) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("media", mode);
    const request = operation(tx.objectStore("media"));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Capture outbox write aborted"));
  });
}

export function pendingMedia() {
  return transaction("readonly", (store) => store.getAll());
}

export async function persistMedia(item) {
  const pending = await pendingMedia();
  if (pending.reduce((sum, row) => sum + row.bytes.byteLength, 0) + item.bytes.byteLength > MAX_PENDING_BYTES) {
    throw new Error("Capture upload backlog is full. Recording stopped to preserve pending data.");
  }
  return transaction("readwrite", (store) => store.put(item));
}

export function acknowledgeMedia(id) {
  return transaction("readwrite", (store) => store.delete(id));
}

/** Pure drain helper, also tested with failure/replay scenarios. */
export async function drainMedia(items, upload, acknowledge) {
  for (const item of items.sort((a, b) => a.seq - b.seq)) {
    await upload(item);
    await acknowledge(item.id);
  }
}
