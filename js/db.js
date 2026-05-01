/* MarkdownLab — IndexedDB wrapper.
 *
 * Schema:
 *   projects  → { id, name, color, order, createdAt }
 *   files     → { id, projectId, name, content, order, createdAt, updatedAt,
 *                 scrollEditor, scrollPreview, cursor }
 *   session   → { key, value }        (singleton key/value pairs)
 *
 * The wrapper exposes a minimal promise-based API. Every call that touches the
 * DB first runs `await dbReady` so callers can fire without awaiting `openDb`
 * explicitly.
 *
 * Private-mode / quota / blocked-upgrade failures are surfaced through
 * `dbReady` rejecting; callers can catch and fall back to a localStorage shim.
 */

const DB_NAME = 'mdlab';
const DB_VERSION = 1;

let _db = null;
let _dbPromise = null;
let _blockedListener = null;

export function onBlocked(fn) {
  _blockedListener = fn;
}

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable in this browser.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('projects')) {
        const s = db.createObjectStore('projects', { keyPath: 'id' });
        s.createIndex('order', 'order');
      }
      if (!db.objectStoreNames.contains('files')) {
        const s = db.createObjectStore('files', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId');
        s.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('session')) {
        db.createObjectStore('session', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        try { db.close(); } catch {}
        _db = null;
        _dbPromise = null;
      };
      _db = db;
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed.'));
    req.onblocked = () => {
      const err = new Error('IndexedDB upgrade blocked by another tab. Close other MarkdownLab tabs and reload.');
      try { _blockedListener?.(err); } catch {}
      reject(err);
    };
  });
  return _dbPromise;
}

export const dbReady = openDb().catch((err) => {
  console.warn('IndexedDB unavailable — falling back to localStorage shim.', err);
  return null;
});

function getDb() {
  if (_db) return Promise.resolve(_db);
  if (!_dbPromise) _dbPromise = openDb();
  return _dbPromise.catch(() => null);
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror   = () => reject(request.error);
  });
}

// A request's onsuccess fires when the request is queued in the tx, BEFORE
// the tx commits. Quota / constraint errors can still fire on the tx itself
// (oncomplete / onerror / onabort). `awaitRequest` wraps both so callers
// get a promise that only resolves once the bytes are durable.
function awaitRequest(request) {
  return new Promise((resolve, reject) => {
    const tx = request.transaction;
    let requestResult;
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err || new Error('IndexedDB transaction failed')); } };

    request.onerror   = () => fail(request.error);
    if (tx) {
      request.onsuccess = () => { requestResult = request.result; };
      tx.oncomplete     = () => { if (!settled) { settled = true; resolve(requestResult); } };
      tx.onerror        = () => fail(tx.error);
      tx.onabort        = () => fail(tx.error || new Error('IndexedDB transaction aborted (likely quota)'));
    } else {
      // No transaction attached — fall back to request-level resolution.
      request.onsuccess = () => { if (!settled) { settled = true; resolve(request.result); } };
    }
  });
}

async function tx(storeName, mode = 'readonly') {
  const db = await getDb();
  if (!db) throw new Error('DB_UNAVAILABLE');
  const t = db.transaction(storeName, mode);
  return t.objectStore(storeName);
}

export async function put(store, value) {
  const s = await tx(store, 'readwrite');
  return awaitRequest(s.put(value));
}

export async function bulkPut(store, values) {
  if (values.length === 0) return [];
  const s = await tx(store, 'readwrite');
  // All puts share one transaction; awaiting the last one's tx completion
  // guarantees the whole batch is durable. Earlier requests resolve their
  // individual `request.result` synchronously via `onsuccess`.
  const results = new Array(values.length);
  for (let i = 0; i < values.length - 1; i++) {
    const req = s.put(values[i]);
    req.onsuccess = () => { results[i] = req.result; };
  }
  results[values.length - 1] = await awaitRequest(s.put(values[values.length - 1]));
  return results;
}

export async function get(store, key) {
  const s = await tx(store);
  return promisify(s.get(key));
}

export async function del(store, key) {
  const s = await tx(store, 'readwrite');
  return awaitRequest(s.delete(key));
}

export async function getAll(store) {
  const s = await tx(store);
  return promisify(s.getAll());
}

export async function getAllByIndex(store, indexName, value) {
  const s = await tx(store);
  const idx = s.index(indexName);
  return promisify(idx.getAll(value));
}

// Session: singleton key/value pairs (active-file, sidebar width, etc.).
export async function sessionGet(key) {
  try {
    const row = await get('session', key);
    return row ? row.value : undefined;
  } catch {
    return undefined;
  }
}

export async function sessionSet(key, value) {
  try { return await put('session', { key, value }); } catch { return undefined; }
}

// ---- localStorage fallback shim ----------------------------------------
// Activated when IndexedDB fails (private mode, quota, hostile profiles).
// API-compatible with the functions above but capped at ~3 MB total.

const LS_PREFIX = 'mdlab.lsdb.v1.';
const LS_INDEX_PREFIX = LS_PREFIX + 'index.';

function lsList(store) {
  try {
    const raw = localStorage.getItem(LS_INDEX_PREFIX + store);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function lsSaveList(store, ids) {
  try {
    localStorage.setItem(LS_INDEX_PREFIX + store, JSON.stringify(ids));
  } catch (e) {
    const err = new Error('Browser storage is full. Delete some files to continue.');
    err.cause = e;
    err.code = 'STORAGE_FULL';
    throw err;
  }
}

function lsKey(store, id) { return `${LS_PREFIX}${store}.${id}`; }

export const lsFallback = {
  async put(store, value) {
    const id = value.id ?? value.key;
    try {
      localStorage.setItem(lsKey(store, id), JSON.stringify(value));
    } catch (e) {
      const err = new Error('Browser storage is full. Delete some files to continue.');
      err.cause = e;
      err.code = 'STORAGE_FULL';
      throw err;
    }
    const ids = lsList(store);
    if (!ids.includes(id)) { ids.push(id); lsSaveList(store, ids); }
    return id;
  },
  async get(store, id) {
    try {
      const raw = localStorage.getItem(lsKey(store, id));
      return raw ? JSON.parse(raw) : undefined;
    } catch { return undefined; }
  },
  async del(store, id) {
    try { localStorage.removeItem(lsKey(store, id)); } catch {}
    try { lsSaveList(store, lsList(store).filter(x => x !== id)); } catch {}
  },
  async getAll(store) {
    const ids = lsList(store);
    const rows = [];
    for (const id of ids) {
      const r = await this.get(store, id);
      if (r) rows.push(r);
    }
    return rows;
  },
  async getAllByIndex(store, indexName, value) {
    const all = await this.getAll(store);
    return all.filter(r => r[indexName] === value);
  },
  async sessionGet(key) {
    return (await this.get('session', key))?.value;
  },
  async sessionSet(key, value) {
    return this.put('session', { key, value });
  },
};

// Main DB facade — routes to IndexedDB or falls through to localStorage.
// Callers use `DB.*` not the raw functions, so switching is transparent.
export const DB = {
  _useFallback: null,

  async ready() {
    const db = await dbReady;
    this._useFallback = !db;
    return !!db;
  },

  async _route(op, args, fallbackFn) {
    if (this._useFallback === null) await this.ready();
    if (this._useFallback) return fallbackFn(...args);
    try {
      return await op(...args);
    } catch (err) {
      if (isIdbRuntimeFailure(err)) {
        console.warn('IndexedDB write failed at runtime — switching to localStorage shim.', err);
        this._useFallback = true;
        return fallbackFn(...args);
      }
      throw err;
    }
  },

  put(store, value)                      { return this._route(put,            [store, value],             lsFallback.put.bind(lsFallback)); },
  bulkPut(store, values)                 { return this._route(bulkPut,        [store, values],            (s, v) => Promise.all(v.map(x => lsFallback.put(s, x)))); },
  get(store, key)                        { return this._route(get,            [store, key],               lsFallback.get.bind(lsFallback)); },
  del(store, key)                        { return this._route(del,            [store, key],               lsFallback.del.bind(lsFallback)); },
  getAll(store)                          { return this._route(getAll,         [store],                    lsFallback.getAll.bind(lsFallback)); },
  getAllByIndex(store, indexName, value) { return this._route(getAllByIndex,  [store, indexName, value],  lsFallback.getAllByIndex.bind(lsFallback)); },
  sessionGet(key)                        { return this._route(sessionGet,     [key],                      lsFallback.sessionGet.bind(lsFallback)); },
  sessionSet(key, value)                 { return this._route(sessionSet,     [key, value],               lsFallback.sessionSet.bind(lsFallback)); },
};

function isIdbRuntimeFailure(err) {
  const name = err?.name || '';
  return name === 'QuotaExceededError'
      || name === 'AbortError'
      || name === 'UnknownError'
      || name === 'InvalidStateError'
      || /DB_UNAVAILABLE/.test(err?.message || '');
}

export function newId() {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8)
  );
}
