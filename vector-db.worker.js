import { pipeline, env } from "@huggingface/transformers";

// Transformers.js config
// Cache buster: 2026-01-25-1
env.allowLocalModels = false;
env.useBrowserCache = true;
// Disable multi-threading to prevent WASM OOM/Aborted errors in worker
env.backends.onnx.wasm.numThreads = 1;
// Ensure we don't try to spawn more workers from within this worker
env.backends.onnx.wasm.proxy = false;

const MODEL_ID = "onnx-community/embeddinggemma-300m-ONNX";
let db = null;
let dbPromise = null;
let embedderPromise = null;
let opfsReported = false;
let useIdbFallback = false;
let rehydratePromise = null;
let idbInstancePromise = null;
const IDB_DB_NAME = "chatforge_vectors";
const IDB_STORE = "chunks";

const WORKER_VERSION = "2026-01-26-6";
let debugEnabled = false;
let debugEchoToConsole = false;
let idbPutCount = 0;
let vec0Available = false;
let vec0DisabledReason = null;
let lastUsedBackend = "unknown";
const EMBED_BATCH_SIZE_MAX = 16;
const MIN_WEBGPU_DEVICE_MEMORY_GB = 4;
const MIN_WEBGPU_CPU_CORES = 4;

function shouldUseWebgpu(adapterInfo) {
  const nav = self.navigator || {};
  const deviceMemory =
    typeof nav.deviceMemory === "number" ? nav.deviceMemory : null;
  const hardwareConcurrency =
    typeof nav.hardwareConcurrency === "number"
      ? nav.hardwareConcurrency
      : null;
  const desc = String(adapterInfo?.description || "").toLowerCase();
  const isSoftware =
    desc.includes("swiftshader") ||
    desc.includes("llvmpipe") ||
    desc.includes("software");

  if (isSoftware) {
    return {
      use: false,
      reason: "software-adapter",
      deviceMemory,
      hardwareConcurrency,
    };
  }

  if (deviceMemory !== null && deviceMemory < MIN_WEBGPU_DEVICE_MEMORY_GB) {
    return {
      use: false,
      reason: "low-device-memory",
      deviceMemory,
      hardwareConcurrency,
    };
  }

  if (
    hardwareConcurrency !== null &&
    hardwareConcurrency < MIN_WEBGPU_CPU_CORES
  ) {
    return {
      use: false,
      reason: "low-cpu-cores",
      deviceMemory,
      hardwareConcurrency,
    };
  }

  return {
    use: true,
    reason: null,
    deviceMemory,
    hardwareConcurrency,
  };
}

function getInitialBatchSize(totalCount) {
  if (lastUsedBackend === "webgpu") {
    if (totalCount >= 32) return 16;
    if (totalCount >= 16) return 8;
    if (totalCount >= 8) return 4;
    return 2;
  }
  return 1;
}

function vec0Disable(phase, reason, error) {
  vec0Available = false;
  vec0DisabledReason = reason;
  postDebug("vec0_insert_error", {
    phase,
    disabled: true,
    reason,
    error: error ? String((error && error.message) || error) : null,
  });
}

function vec0Upsert(_db, rowId, embeddingBytes, phase) {
  if (!vec0Available) return false;
  try {
    // Avoid "INSERT OR REPLACE" on vec0 virtual tables: it can trigger sqlite errors
    // depending on the virtual table's conflict handling.
    _db.exec({
      sql: "INSERT INTO vectors(rowid, embedding) VALUES (?, ?)",
      bind: [rowId, embeddingBytes],
    });
    return true;
  } catch (e1) {
    try {
      // Best-effort conflict resolution: delete then insert.
      _db.exec({
        sql: "DELETE FROM vectors WHERE rowid = ?",
        bind: [rowId],
      });
      _db.exec({
        sql: "INSERT INTO vectors(rowid, embedding) VALUES (?, ?)",
        bind: [rowId, embeddingBytes],
      });
      return true;
    } catch (e2) {
      vec0Disable(phase, "insert_failed", e2);
      return false;
    }
  }
}

function toVecBlobFromEmbedding(embedding) {
  try {
    if (!embedding) return null;
    // vec0(embedding float[768]) expects 768 float32 values => 3072 bytes
    const expectedBytes = 768 * 4;

    if (embedding instanceof Float32Array) {
      if (embedding.byteLength !== expectedBytes) return null;
      return new Uint8Array(
        embedding.buffer,
        embedding.byteOffset,
        embedding.byteLength,
      );
    }

    if (embedding instanceof ArrayBuffer) {
      if (embedding.byteLength !== expectedBytes) return null;
      return new Uint8Array(embedding);
    }

    if (embedding instanceof Uint8Array) {
      if (embedding.byteLength !== expectedBytes) return null;
      return embedding;
    }

    // IDB may give us ArrayBuffer-like objects
    if (typeof embedding.byteLength === "number") {
      const bytes = new Uint8Array(embedding);
      if (bytes.byteLength !== expectedBytes) return null;
      return bytes;
    }

    return null;
  } catch (_e) {
    return null;
  }
}

function postDebug(event, data = {}) {
  if (!debugEnabled) return;
  const payload = {
    type: "debug",
    area: "vector-worker",
    event,
    version: WORKER_VERSION,
    crossOriginIsolated: Boolean(self.crossOriginIsolated),
    data,
  };
  try {
    // Helps when DevTools doesn't show worker logs easily.
    self.postMessage(payload);
  } catch (e) {
    // ignore
  }
  if (debugEchoToConsole) {
    try {
      console.log("[vector-worker debug]", event, payload);
    } catch (e) {
      // ignore
    }
  }
}

function openIdb() {
  if (!self.indexedDB) return Promise.resolve(null);
  if (idbInstancePromise) return idbInstancePromise;

  idbInstancePromise = new Promise((resolve, reject) => {
    postDebug("idb_open_start", { db: IDB_DB_NAME, store: IDB_STORE });
    const request = indexedDB.open(IDB_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        const store = db.createObjectStore(IDB_STORE, { keyPath: "key" });
        store.createIndex("byUser", "userId", { unique: false });
      }
      postDebug("idb_upgrade", { version: request.result.version });
    };
    request.onsuccess = () => {
      postDebug("idb_open_success", { version: request.result.version });
      resolve(request.result);
    };
    request.onerror = () => {
      postDebug("idb_open_error", {
        error: String(request.error || "unknown"),
      });
      reject(request.error);
    };
  });

  return idbInstancePromise;
}

async function idbPutChunk(chunk) {
  const idb = await openIdb();
  if (!idb) return;

  idbPutCount++;
  if (debugEnabled && (idbPutCount <= 3 || idbPutCount % 25 === 0)) {
    postDebug("idb_put", {
      count: idbPutCount,
      key: chunk.key,
      userId: chunk.userId,
      sourceName: chunk.sourceName,
      chunkIndex: chunk.chunkIndex,
      embeddingBytes:
        chunk &&
        chunk.embedding &&
        typeof chunk.embedding.byteLength === "number"
          ? chunk.embedding.byteLength
          : null,
      status: chunk.status,
    });
  }

  await new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(IDB_STORE).put(chunk);
  });
}

async function idbDeleteUser(userId) {
  const idb = await openIdb();
  if (!idb) return;

  postDebug("idb_delete_user_start", { userId });

  await new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    const index = store.index("byUser");
    const req = index.openCursor(IDBKeyRange.only(userId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  postDebug("idb_delete_user_done", { userId });
}

async function rehydrateFromIdb(_db) {
  if (rehydratePromise) return rehydratePromise;

  rehydratePromise = (async () => {
    const idb = await openIdb();
    if (!idb) return;

    let restored = 0;
    let scanned = 0;
    let skippedNoEmbedding = 0;

    postDebug("rehydrate_start");

    await new Promise((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE, "readonly");
      const store = tx.objectStore(IDB_STORE);
      const req = store.openCursor();

      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;

        scanned++;

        const row = cursor.value;
        try {
          const embeddingBytes = toVecBlobFromEmbedding(row.embedding);
          if (!embeddingBytes) {
            skippedNoEmbedding++;
            cursor.continue();
            return;
          }

          _db.exec({
            sql: "INSERT OR REPLACE INTO training_chunks (id, userId, sourceName, chunkIndex, text, embedding, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
            bind: [
              row.id,
              row.userId,
              row.sourceName,
              row.chunkIndex,
              row.text,
              embeddingBytes,
              row.status,
            ],
          });

          try {
            vec0Upsert(_db, row.id, embeddingBytes, "rehydrate");
          } catch (e) {
            // vec0 might not exist or the value format is rejected.
            // Disable vec0 after the first failure to avoid spamming console.
            vec0Disable("rehydrate", "insert_failed", e);
          }

          restored++;
        } catch (e) {
          console.warn("IDB rehydrate row failed", e);
        }

        cursor.continue();
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // Helpful debug signal: lets the UI know rehydration happened.
    postDebug("rehydrate_done", { restored, scanned, skippedNoEmbedding });
    self.postMessage({
      type: "idb_rehydrate_done",
      restored,
      scanned,
      skippedNoEmbedding,
      version: WORKER_VERSION,
    });
  })();

  return rehydratePromise;
}

async function idbGetSummary(limitUsers = 5) {
  const idb = await openIdb();
  if (!idb) return { available: false };

  const countsByUser = Object.create(null);
  let total = 0;

  await new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, "readonly");
    const store = tx.objectStore(IDB_STORE);
    const req = store.openCursor();

    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;

      total++;
      const row = cursor.value;
      const uid = row && row.userId ? String(row.userId) : "(missing-userId)";
      countsByUser[uid] = (countsByUser[uid] || 0) + 1;
      cursor.continue();
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  const topUsers = Object.keys(countsByUser)
    .map((u) => ({ userId: u, count: countsByUser[u] }))
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(1, limitUsers || 5));

  return { available: true, total, topUsers };
}

async function debugGetState(userId) {
  const _db = await getSQLite();

  let sqliteTotals = null;
  try {
    const rows = _db.selectObjects(
      "SELECT COUNT(*) as totalRows, COUNT(DISTINCT userId) as distinctUsers FROM training_chunks",
      [],
    );
    sqliteTotals =
      rows && rows[0] ? rows[0] : { totalRows: 0, distinctUsers: 0 };
  } catch (e) {
    sqliteTotals = { error: String((e && e.message) || e) };
  }

  let sqliteForUser = null;
  let sqliteByUser = null;
  try {
    sqliteForUser = _db.selectObjects(
      "SELECT status, COUNT(*) as count, COALESCE(SUM(length(embedding)), 0) as bytes FROM training_chunks WHERE userId = ? GROUP BY status",
      [userId],
    );
  } catch (e) {
    sqliteForUser = { error: String((e && e.message) || e) };
  }

  try {
    sqliteByUser = _db.selectObjects(
      "SELECT userId, status, COUNT(*) as count FROM training_chunks GROUP BY userId, status ORDER BY count DESC LIMIT 10",
      [],
    );
  } catch (e) {
    sqliteByUser = { error: String((e && e.message) || e) };
  }

  const idbSummary = await idbGetSummary(5);

  self.postMessage({
    type: "debug_state",
    version: WORKER_VERSION,
    requestedUserId: userId,
    crossOriginIsolated: Boolean(self.crossOriginIsolated),
    useIdbFallback: Boolean(useIdbFallback),
    sqliteTotals,
    sqliteForUser,
    sqliteByUser,
    idbSummary,
  });
}

async function getSQLite() {
  if (db) return db;
  if (dbPromise) return dbPromise;

  dbPromise = (async () => {
    // Load from local public directory to share origin (avoids COOP/COEP worker issues)
    // Use variable to avoid bundler resolution
    const path = "/sqlite-vec/sqlite3.mjs";
    const { default: init } = await import(/* @vite-ignore */ path);

    const sqlite3 = await init({
      // Tell sqlite3 where to find the wasm and proxy files
      locateFile: (file, scriptDir) => {
        // scriptDir will be the worker's location (assets/...) or blob
        // We want to force it to use our public/sqlite-vec/ location
        return `/sqlite-vec/${file}`;
      },
    });

    // OPFS requires crossOriginIsolated + OPFS VFS support.
    // Some builds expose sqlite3.oo1.opfs even when it can't be used (e.g. crossOriginIsolated=false).
    const canUseOpfs =
      Boolean(self.crossOriginIsolated) && "opfs" in sqlite3.oo1;

    postDebug("sqlite_init", {
      canUseOpfs,
      hasOo1Opfs: Boolean("opfs" in sqlite3.oo1),
    });

    let localDb;
    // sqlite3.oo1 DB flags: c=create, w=readwrite, t=trace-to-console.
    // Never enable SQL tracing ("t") here: it is extremely verbose and was
    // the source of the noisy "SQL TRACE #..." console spam.
    const dbFlags = "c";
    if (canUseOpfs) {
      try {
        localDb = new sqlite3.oo1.OpfsDb("/chat_vectors.db");
        console.log("Worker: Using OPFS sqlite3_vfs");
        postDebug("sqlite_backend", { backend: "opfs" });
      } catch (e) {
        console.warn("Worker: OPFS init failed, falling back", e);
        useIdbFallback = true;
        localDb = new sqlite3.oo1.DB("/chat_vectors.db", dbFlags);
        postDebug("sqlite_backend", {
          backend: dbFlags,
          opfsInitFailed: true,
          error: String((e && e.message) || e),
        });
      }
    } else {
      console.warn(
        "Worker: OPFS not available (or not isolated), using temporary DB",
      );
      useIdbFallback = true;
      localDb = new sqlite3.oo1.DB("/chat_vectors.db", dbFlags);
      postDebug("sqlite_backend", { backend: dbFlags, opfsInitFailed: false });
    }

    if (useIdbFallback && !opfsReported) {
      opfsReported = true;
      self.postMessage({
        type: "opfs_unavailable",
        reason: self.crossOriginIsolated
          ? "opfs-not-supported"
          : "crossOriginIsolated-false",
        fallback: "indexeddb",
      });
    }

    // Init tables
    localDb.exec(`
    CREATE TABLE IF NOT EXISTS training_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT,
      sourceName TEXT,
      chunkIndex INTEGER,
      text TEXT,
      embedding BLOB,
      status TEXT,
      UNIQUE(userId, sourceName, chunkIndex)
    );
  `);

    try {
      localDb.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vectors USING vec0(
        embedding float[768]
      );
    `);
      vec0Available = true;
    } catch (e) {
      console.warn(
        "Failed to create virtual table vec0. fast vector search not available.",
        e,
      );
      vec0Available = false;
      vec0DisabledReason = "create_failed";
    }

    // Self-test vec0 insert once. If it fails, disable vec0 for the session.
    if (vec0Available) {
      try {
        const zero = new Uint8Array(768 * 4);
        const testRowId = 9007199254740991; // Number.MAX_SAFE_INTEGER
        vec0Upsert(localDb, testRowId, zero, "self_test");
        localDb.exec({
          sql: "DELETE FROM vectors WHERE rowid = ?",
          bind: [testRowId],
        });
      } catch (e) {
        vec0Available = false;
        vec0DisabledReason = "self_test_failed";
        postDebug("vec0_self_test_failed", {
          error: String((e && e.message) || e),
        });
        // Best effort: drop the broken table so later queries don't try to use it.
        try {
          localDb.exec("DROP TABLE IF EXISTS vectors");
        } catch (_e) {
          // ignore
        }
      }
    }

    // Always try to rehydrate from IndexedDB if data exists.
    // This makes refresh persistence work even when OPFS detection differs between sessions.
    await rehydrateFromIdb(localDb);

    db = localDb;
    return db;
  })();

  try {
    return await dbPromise;
  } catch (e) {
    // Allow retry if init failed
    dbPromise = null;
    throw e;
  }
}

async function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = (async () => {
      let webgpuSupported = false;
      let webgpuError = null;
      let adapterInfo = null;

      try {
        // Step 1: Check if API exists in this context
        const hasNavigatorGpu = Boolean(self.navigator && self.navigator.gpu);

        if (hasNavigatorGpu) {
          // Step 2: Try manual adapter request (more reliable than just checking API)
          const adapter = await self.navigator.gpu.requestAdapter();
          if (adapter) {
            webgpuSupported = true;
            // Get info about the hardware if possible
            if (adapter.info) {
              adapterInfo = {
                vendor: adapter.info.vendor,
                architecture: adapter.info.architecture,
                device: adapter.info.device,
                description: adapter.info.description,
              };
            }
          } else {
            webgpuError =
              "navigator.gpu exists but requestAdapter() returned null (Linux driver issue?)";
          }
        } else {
          webgpuError =
            "self.navigator.gpu is undefined in this worker context";
        }

        // Step 3: Check what Transformers.js thinks
        const isSupportedFn = env?.backends?.onnx?.webgpu?.isSupported;
        const transformersThinksSupported =
          typeof isSupportedFn === "function" ? await isSupportedFn() : false;

        // Force supported if we got an adapter, even if transformers.js is conservative
        if (webgpuSupported || transformersThinksSupported) {
          webgpuSupported = true;
        }
      } catch (e) {
        webgpuSupported = false;
        webgpuError =
          "Exception during WebGPU check: " + String((e && e.message) || e);
      }

      const resourceDecision = shouldUseWebgpu(adapterInfo);
      if (webgpuSupported && !resourceDecision.use) {
        webgpuSupported = false;
        webgpuError = `resource-guard:${resourceDecision.reason}`;
      }

      postDebug("embedder_backend_detailed", {
        model: MODEL_ID,
        webgpuSupported,
        webgpuError,
        adapterInfo,
        resourceDecision,
        wasmThreads: env?.backends?.onnx?.wasm?.numThreads,
      });

      // Use WebGPU when available. Otherwise let Transformers.js pick the default CPU backend.
      const options = webgpuSupported ? { device: "webgpu" } : undefined;
      const pipe = await pipeline("feature-extraction", MODEL_ID, options);

      const selectedDevice =
        pipe?.device || pipe?.model?.device || options?.device || "auto";
      const selectedDeviceStr = String(selectedDevice).toLowerCase();
      lastUsedBackend = selectedDeviceStr.includes("webgpu")
        ? "webgpu"
        : "wasm";

      postDebug("embedder_selected_device", {
        selectedDevice,
      });

      return pipe;
    })();
  }
  return embedderPromise;
}

function chunkText(text, maxLen = 1000, overlap = 200) {
  const sections = [];
  const parts = text.split(/^##\s+/m);

  if (parts.length === 1) {
    sections.push(text);
  } else {
    const head = parts.shift();
    if (head && head.trim()) sections.push(head.trim());
    for (const part of parts) {
      const lines = part.split("\n");
      const title = lines.shift() || "";
      const body = lines.join("\n").trim();
      sections.push(`## ${title}\n${body}`.trim());
    }
  }

  const chunks = [];
  for (const section of sections) {
    if (section.length <= maxLen) {
      chunks.push(section);
      continue;
    }
    let start = 0;
    while (start < section.length) {
      const end = start + maxLen;
      chunks.push(section.slice(start, end).trim());
      start = end - overlap;
      if (start >= section.length - overlap) break;
    }
  }

  return chunks;
}

async function clearUserData(userId) {
  const _db = await getSQLite();
  _db.exec({
    sql: "DELETE FROM training_chunks WHERE userId = ?",
    bind: [userId],
  });
  // We always mirror embeddings to IndexedDB, so deletes must also clear IndexedDB.
  await idbDeleteUser(userId);
}

async function getLocalStats(userId) {
  const _db = await getSQLite();
  const stats = _db.selectObjects(
    "SELECT COUNT(*) as count, COALESCE(SUM(length(embedding)), 0) as bytes FROM training_chunks WHERE userId = ? AND status = 'completed'",
    [userId],
  );

  const row = stats?.[0] || { count: 0, bytes: 0 };
  self.postMessage({
    type: "local_stats",
    count: Number(row.count || 0),
    bytes: Number(row.bytes || 0),
  });
}

async function prepareWithProgress(userId, text, sourceName, clearExisting) {
  const _db = await getSQLite();
  const chunks = chunkText(text);

  if (clearExisting) {
    _db.exec({
      sql: "DELETE FROM training_chunks WHERE userId = ?",
      bind: [userId],
    });
    // We always mirror embeddings to IndexedDB, so deletes must also clear IndexedDB.
    await idbDeleteUser(userId);
  }

  // Initialize pending
  for (let i = 0; i < chunks.length; i++) {
    _db.exec({
      sql: "INSERT OR IGNORE INTO training_chunks (userId, sourceName, chunkIndex, text, status) VALUES (?, ?, ?, ?, ?)",
      bind: [userId, sourceName, i, chunks[i], "pending"],
    });
  }

  // Count pending
  const pending = _db.selectObjects(
    "SELECT * FROM training_chunks WHERE userId = ? AND sourceName = ? AND status = 'pending' ORDER BY chunkIndex ASC",
    [userId, sourceName],
  );

  let completed = chunks.length - pending.length;
  self.postMessage({ type: "progress", completed, total: chunks.length });

  // Init embedder
  const pipe = await getEmbedder();

  if (lastUsedBackend === "webgpu") {
    // In our detailed check, we might have set webgpuSupported=true but we need info from the promise
    // But since pipe is already loaded, we can just log the success.
    console.log(
      "[vector-worker] Przygotowanie SQL: Używam WebGPU (GPU acceleration)",
    );
  } else {
    // We can't easily get the error here unless we store it globally, but for now we'll just log failure.
    console.log(
      "[vector-worker] Przygotowanie SQL: Używam CPU/WASM (WebGPU niedostępne). Sprawdź ?debugVector=1 w URL i 'embedder_backend_detailed' w konsoli.",
    );
  }

  // Process in batches with auto-tuning (improves WebGPU throughput)
  let batchSize = getInitialBatchSize(pending.length);
  let prevMsPerItem = null;
  let i = 0;
  while (i < pending.length) {
    const currentBatchSize = batchSize;
    const batch = pending.slice(i, i + currentBatchSize);
    const texts = batch.map((row) => row.text);

    const t0 = performance.now();
    const output = await pipe(texts, { pooling: "mean", normalize: true });
    const t1 = performance.now();

    const vectors = output?.data || [];

    for (let j = 0; j < batch.length; j++) {
      const row = batch[j];
      const vectorData = vectors[j];
      const f32 = vectorData ? new Float32Array(vectorData) : null;
      const embeddingBytes = f32 ? toVecBlobFromEmbedding(f32) : null;

      if (!embeddingBytes) {
        postDebug("embedding_shape_mismatch", {
          userId,
          sourceName,
          chunkIndex: row.chunkIndex,
          byteLength: f32 ? f32.byteLength : null,
          length: f32 ? f32.length : null,
        });
        // Mark as completed in SQL without vec0 index; the slow-scan path can still work.
        _db.exec({
          sql: "UPDATE training_chunks SET status = 'completed' WHERE id = ?",
          bind: [row.id],
        });
        completed++;
        self.postMessage({ type: "progress", completed, total: chunks.length });
        continue;
      }

      _db.exec({
        sql: "UPDATE training_chunks SET embedding = ?, status = 'completed' WHERE id = ?",
        bind: [embeddingBytes, row.id],
      });

      // Try to insert into vector index
      try {
        vec0Upsert(_db, row.id, embeddingBytes, "prepare");
      } catch (e) {
        // vec0 might not exist or failed. Disable immediately.
        vec0Disable("prepare", "insert_failed", e);
      }

      // Always mirror completed embeddings to IndexedDB for persistence across refresh.
      // (Even if OPFS is available, this provides a robust fallback.)
      await idbPutChunk({
        key: `${userId}::${sourceName}::${row.chunkIndex}`,
        id: row.id,
        userId,
        sourceName,
        chunkIndex: row.chunkIndex,
        text: row.text,
        embedding: embeddingBytes,
        status: "completed",
      });

      completed++;
      self.postMessage({ type: "progress", completed, total: chunks.length });
    }

    const msPerItem = (t1 - t0) / Math.max(1, batch.length);
    const remaining = pending.length - (i + batch.length);

    if (lastUsedBackend === "webgpu" && prevMsPerItem !== null) {
      if (
        msPerItem < prevMsPerItem * 0.9 &&
        batchSize < EMBED_BATCH_SIZE_MAX &&
        remaining >= batchSize * 2
      ) {
        batchSize = Math.min(EMBED_BATCH_SIZE_MAX, batchSize * 2);
      } else if (msPerItem > prevMsPerItem * 1.25 && batchSize > 1) {
        batchSize = Math.max(1, Math.floor(batchSize / 2));
      }
    }

    if (debugEnabled) {
      postDebug("embedder_batch_tune", {
        batchSize,
        currentBatchSize,
        msPerItem,
        prevMsPerItem,
        remaining,
        backend: lastUsedBackend,
      });
    }

    prevMsPerItem = msPerItem;
    i += batch.length;
  }

  self.postMessage({ type: "done_prepare" });
}

async function searchVectors(userId, vector, topK = 10) {
  const _db = await getSQLite();
  if (!vec0Available) {
    self.postMessage({ type: "search_results", results: [] });
    return;
  }
  const f32 = new Float32Array(vector);
  const embeddingBytes = toVecBlobFromEmbedding(f32);
  if (!embeddingBytes) {
    self.postMessage({ type: "search_results", results: [] });
    return;
  }

  try {
    const rows = _db.selectObjects(
      `
      SELECT
        t.id, t.text, t.sourceName, t.chunkIndex,
        distance
      FROM vectors v
      JOIN training_chunks t ON t.id = v.rowid
      WHERE v.embedding MATCH ?
        AND k = ?
      ORDER BY distance
    `,
      [embeddingBytes, topK],
    );
    self.postMessage({ type: "search_results", results: rows });
  } catch (e) {
    console.error("Vector search failed (likely vec0 table missing)", e);
    self.postMessage({ type: "search_results", results: [] });
  }
}

async function getCompletedChunks(userId) {
  const _db = await getSQLite();
  const rows = _db.selectObjects(
    "SELECT * FROM training_chunks WHERE userId = ? AND status = 'completed'",
    [userId],
  );

  // Need to convert BLOB (Uint8Array/ArrayBuffer) back to normal array/float32 for transfer or usage
  const result = rows.map((r) => {
    // r.embedding is a Uint8Array viewing the bytes
    // We need to view those same bytes as Float32
    const f32 = new Float32Array(
      r.embedding.buffer,
      r.embedding.byteOffset,
      r.embedding.byteLength / 4,
    );
    return {
      ...r,
      embedding: Array.from(f32),
    };
  });

  self.postMessage({ type: "completed_chunks", rows: result });
}

async function embedQuery(text) {
  const pipe = await getEmbedder();
  const out = await pipe(text, { pooling: "mean", normalize: true });
  self.postMessage({ type: "embed_result", vector: Array.from(out.data) });
}

self.onmessage = async (e) => {
  const { action, payload } = e.data;
  try {
    switch (action) {
      case "set_debug":
        debugEnabled = Boolean(payload && payload.enabled);
        debugEchoToConsole = Boolean(payload && payload.echoToConsole);
        postDebug("debug_enabled", { enabled: debugEnabled });
        self.postMessage({
          type: "debug_ack",
          enabled: debugEnabled,
          echoToConsole: debugEchoToConsole,
          version: WORKER_VERSION,
        });
        break;
      case "prepare":
        await prepareWithProgress(
          payload.userId,
          payload.text,
          payload.sourceName,
          Boolean(payload.clearExisting),
        );
        break;
      case "get_upload_data":
        await getCompletedChunks(payload.userId);
        break;
      case "get_local_stats":
        await getLocalStats(payload.userId);
        break;
      case "clear_user_data":
        await clearUserData(payload.userId);
        self.postMessage({ type: "cleared_user_data" });
        break;
      case "embed_query":
        await embedQuery(payload.text);
        break;
      case "preload":
        await getEmbedder();
        break;
      case "debug_get_state":
        await debugGetState(payload && payload.userId);
        break;
      case "search_vectors":
        await searchVectors(payload.userId, payload.vector, payload.topK);
        break;
      default:
        console.warn("Unknown worker action:", action);
    }
  } catch (err) {
    console.error("Worker Error:", err);
    self.postMessage({ type: "error", error: err.message });
  }
};
