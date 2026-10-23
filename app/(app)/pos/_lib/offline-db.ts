/**
 * The till's IndexedDB (offline-till-spec OF10): `meta` holds the enrolled device, the snapshot and the last server
 * contact per register; `queue` holds offline sales by Idempotency-Key. Browser only. The sale and the device's
 * series counter are written in one transaction, before the slip prints.
 */
import type { TillSnapshot } from "@/modules/sales";
import type { OfflineDevice, QueueEntry } from "./offline";

const DB_NAME = "pos-offline";
const META = "meta";
const QUEUE = "queue";

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(META);
      request.result.createObjectStore(QUEUE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      opening = null;
      reject(request.error);
    };
  });
  return opening;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

async function get<T>(store: string, key: string): Promise<T | null> {
  const tx = (await open()).transaction(store);
  const request = tx.objectStore(store).get(key);
  await done(tx);
  return (request.result as T | undefined) ?? null;
}

async function put(store: string, value: unknown, key?: string): Promise<void> {
  const tx = (await open()).transaction(store, "readwrite");
  tx.objectStore(store).put(value, key);
  await done(tx);
}

const deviceKey = (registerId: string) => `device:${registerId}`;
const snapshotKey = (registerId: string) => `snapshot:${registerId}`;
const contactKey = (registerId: string) => `contact:${registerId}`;

export const loadDevice = (registerId: string) => get<OfflineDevice>(META, deviceKey(registerId));
export const saveDevice = (device: OfflineDevice) => put(META, device, deviceKey(device.registerId));
export const loadSnapshot = (registerId: string) => get<TillSnapshot>(META, snapshotKey(registerId));
export const saveSnapshot = (snapshot: TillSnapshot) => put(META, snapshot, snapshotKey(snapshot.register.id));
export const loadContact = (registerId: string) => get<string>(META, contactKey(registerId));
export const saveContact = (registerId: string, at: string) => put(META, at, contactKey(registerId));

export async function loadQueue(registerId: string): Promise<QueueEntry[]> {
  const tx = (await open()).transaction(QUEUE);
  const request = tx.objectStore(QUEUE).getAll();
  await done(tx);
  return (request.result as QueueEntry[]).filter((entry) => entry.registerId === registerId);
}

export const updateEntry = (entry: QueueEntry) => put(QUEUE, entry);

export async function deleteEntry(key: string): Promise<void> {
  const tx = (await open()).transaction(QUEUE, "readwrite");
  tx.objectStore(QUEUE).delete(key);
  await done(tx);
}

/**
 * Takes the device's next number and queues the sale `build` makes with it, atomically (OF8, OF10): two tabs
 * never share a number, and a sale is never printed without being stored. Resolves once it is on disk.
 */
export async function queueSale<T>(
  registerId: string,
  build: (device: OfflineDevice, seq: number) => { entry: QueueEntry; result: T },
): Promise<T> {
  const tx = (await open()).transaction([META, QUEUE], "readwrite");
  const meta = tx.objectStore(META);
  let out: { result: T } | null = null;
  let failure: unknown = new Error("No offline device on this till");
  const read = meta.get(deviceKey(registerId));
  read.onsuccess = () => {
    const device = read.result as OfflineDevice | undefined;
    if (!device) {
      tx.abort();
      return;
    }
    const seq = device.lastOfflineSaleNo + 1;
    try {
      const built = build(device, seq);
      meta.put({ ...device, lastOfflineSaleNo: seq }, deviceKey(registerId));
      tx.objectStore(QUEUE).add(built.entry);
      out = { result: built.result };
    } catch (err) {
      failure = err;
      tx.abort();
    }
  };
  await done(tx).catch((err) => {
    throw out ? err : failure;
  });
  if (!out) throw failure;
  return (out as { result: T }).result;
}
