const IDB_NAME = 'zhihu-analysis-collector';
const IDB_STORE = 'handles';
const IDB_KEY = 'workbench-temp-folder';

export type DirectoryPermissionState = 'granted' | 'prompt' | 'denied' | 'missing' | 'unknown';

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveWorkbenchDirHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadWorkbenchDirHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openIDB();
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle) || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function ensureDirPermission(
  handle: FileSystemDirectoryHandle | null,
): Promise<FileSystemDirectoryHandle | null> {
  if (!handle) return null;
  try {
    const query = await handle.queryPermission({ mode: 'readwrite' });
    if (query === 'granted') return handle;
    const req = await handle.requestPermission({ mode: 'readwrite' });
    return req === 'granted' ? handle : null;
  } catch {
    return null;
  }
}

export async function pickWorkbenchFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await saveWorkbenchDirHandle(handle);
    return handle;
  } catch {
    return null;
  }
}

export async function writeTextToDir(
  dir: FileSystemDirectoryHandle,
  filename: string,
  text: string,
): Promise<void> {
  const fh = await dir.getFileHandle(filename, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}

export async function readTextFromDir(
  dir: FileSystemDirectoryHandle,
  filename: string,
): Promise<string> {
  const fh = await dir.getFileHandle(filename);
  const file = await fh.getFile();
  return file.text();
}

export async function pickBundleFile(): Promise<{ name: string; text: string } | null> {
  try {
    const [handle] = await window.showOpenFilePicker({
      multiple: false,
      types: [{ description: '知乎分析 bundle', accept: { 'application/json': ['.json'] } }],
    });
    if (!handle) return null;
    const file = await handle.getFile();
    return { name: file.name, text: await file.text() };
  } catch {
    return null;
  }
}

/** 只查询权限，不触发浏览器权限弹窗。 */
export async function inspectDirPermission(
  handle: FileSystemDirectoryHandle | null,
): Promise<DirectoryPermissionState> {
  if (!handle) return 'missing';
  try {
    const state = await handle.queryPermission({ mode: 'readwrite' });
    if (state === 'granted' || state === 'prompt' || state === 'denied') return state;
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
