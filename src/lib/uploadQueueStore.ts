import type { StoredUploadQueueItem, UploadQueueItem } from '../types';

const DATABASE_NAME = 'quepic-upload-queue';
const DATABASE_VERSION = 1;
const STORE_NAME = 'items';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('accountName', 'accountName', { unique: false });
        store.createIndex('scheduledAt', 'scheduledAt', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开上传队列数据库。'));
  });
}

function runTransaction<T>(
  mode: IDBTransactionMode,
  operation: (
    store: IDBObjectStore,
    setResult: (value: T) => void,
    fail: (reason?: unknown) => void,
  ) => void,
): Promise<T> {
  return openDatabase().then((database) => new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    let result: T;
    let resultReady = false;
    let settled = false;

    const fail = (reason?: unknown) => {
      if (settled) return;
      settled = true;
      reject(reason || new Error('上传队列数据库操作失败。'));
    };

    const setResult = (value: T) => {
      result = value;
      resultReady = true;
    };

    operation(store, setResult, fail);

    transaction.oncomplete = () => {
      database.close();
      if (settled) return;
      settled = true;
      if (!resultReady) {
        reject(new Error('上传队列数据库事务未返回结果。'));
        return;
      }
      resolve(result);
    };
    transaction.onerror = () => {
      database.close();
      fail(transaction.error || new Error('上传队列数据库操作失败。'));
    };
    transaction.onabort = () => {
      database.close();
      fail(transaction.error || new Error('上传队列数据库操作已中止。'));
    };
  }));
}

export function toStoredQueueItem(item: UploadQueueItem): StoredUploadQueueItem {
  const status = item.status === 'scheduled' ? 'scheduled' : item.status === 'failed' ? 'failed' : 'waiting';
  return {
    id: item.id,
    file: item.file,
    width: item.width,
    height: item.height,
    accountName: item.accountName,
    uploadAccountName: item.uploadAccountName,
    category: item.category,
    tags: item.tags,
    createdAt: item.createdAt,
    scheduledAt: item.scheduledAt,
    status,
    result: item.result,
    error: item.error,
  };
}

export async function listStoredQueueItems(): Promise<StoredUploadQueueItem[]> {
  return runTransaction<StoredUploadQueueItem[]>('readonly', (store, setResult, fail) => {
    const request = store.getAll();
    request.onsuccess = () => {
      const items = (request.result as StoredUploadQueueItem[])
        .sort((left, right) => right.createdAt - left.createdAt);
      setResult(items);
    };
    request.onerror = () => fail(request.error);
  });
}

export async function saveStoredQueueItem(item: StoredUploadQueueItem): Promise<void> {
  return runTransaction<void>('readwrite', (store, setResult, fail) => {
    const request = store.put(item);
    request.onsuccess = () => setResult(undefined);
    request.onerror = () => fail(request.error);
  });
}

export async function saveStoredQueueItems(items: StoredUploadQueueItem[]): Promise<void> {
  if (items.length === 0) return;
  return runTransaction<void>('readwrite', (store, setResult, fail) => {
    let remaining = items.length;
    for (const item of items) {
      const request = store.put(item);
      request.onerror = () => fail(request.error);
      request.onsuccess = () => {
        remaining -= 1;
        if (remaining === 0) setResult(undefined);
      };
    }
  });
}

export async function removeStoredQueueItem(id: string): Promise<void> {
  return runTransaction<void>('readwrite', (store, setResult, fail) => {
    const request = store.delete(id);
    request.onsuccess = () => setResult(undefined);
    request.onerror = () => fail(request.error);
  });
}
