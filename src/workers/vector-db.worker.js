/**
 * Vector DB Worker - IndexedDB-based vector search
 * Handles archived conversation chunks for RAG retrieval
 * Uses cosine similarity for vector search
 */

import { pipeline, env } from "@huggingface/transformers";

// Configure Transformers.js
env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;

const MODEL_ID = "onnx-community/embeddinggemma-300m-ONNX";
const EMBEDDING_DIM = 768;
const IDB_DB_NAME = "terapeuta_vectors";
const IDB_STORE = "chunks";

let idbInstance = null;
let idbPromise = null;
let embedderPromise = null;

/**
 * Post message to main thread
 */
function postResult(type, data = {}) {
  self.postMessage({ type, ...data });
}

/**
 * Open IndexedDB
 */
function openIdb() {
  if (!self.indexedDB) return Promise.resolve(null);
  if (idbPromise) return idbPromise;

  idbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        const store = db.createObjectStore(IDB_STORE, { keyPath: "id" });
        store.createIndex("bySource", "source", { unique: false });
        store.createIndex("byCreatedAt", "createdAt", { unique: false });
      }
    };

    request.onsuccess = () => {
      idbInstance = request.result;
      resolve(idbInstance);
    };
    request.onerror = () => reject(request.error);
  });

  return idbPromise;
}

/**
 * Store chunk in IndexedDB
 */
async function storeChunk(chunk) {
  const db = await openIdb();
  if (!db) return;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    const request = store.put(chunk);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get all chunks from IndexedDB
 */
async function getAllChunks() {
  const db = await openIdb();
  if (!db) return [];

  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const store = tx.objectStore(IDB_STORE);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Clear all chunks
 */
async function clearAllChunks() {
  const db = await openIdb();
  if (!db) return;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get the embedder pipeline
 */
async function getEmbedder() {
  if (embedderPromise) return embedderPromise;

  embedderPromise = pipeline("feature-extraction", MODEL_ID, {
    dtype: "fp32",
    device: "wasm",
  });

  return embedderPromise;
}

/**
 * Generate embedding for text
 */
async function embed(text) {
  const embedder = await getEmbedder();
  const output = await embedder(text, {
    pooling: "mean",
    normalize: true,
  });
  return Array.from(output.data);
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
}

/**
 * Store chunks with embeddings
 */
async function handleStoreChunks(chunks) {
  const results = [];

  for (const chunk of chunks) {
    try {
      // Generate embedding if not provided
      let embedding = chunk.embedding;
      if (!embedding || embedding.length === 0) {
        embedding = await embed(chunk.text);
      }

      const record = {
        id: chunk.id || `${chunk.source}_${chunk.chunkIndex}`,
        source: chunk.source,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        embedding: embedding,
        createdAt: chunk.createdAt || new Date().toISOString(),
      };

      await storeChunk(record);
      results.push({ id: record.id, success: true });
    } catch (error) {
      console.error("Failed to store chunk:", error);
      results.push({ id: chunk.id, success: false, error: error.message });
    }
  }

  postResult("storeComplete", {
    results,
    count: results.filter((r) => r.success).length,
  });
}

/**
 * Search for similar chunks
 */
async function handleSearch(query, topK = 5) {
  try {
    // Generate query embedding
    const queryEmbedding = await embed(query);

    // Get all chunks
    const chunks = await getAllChunks();

    if (chunks.length === 0) {
      postResult("searchComplete", { results: [] });
      return;
    }

    // Calculate similarities
    const scored = chunks.map((chunk) => ({
      ...chunk,
      score: cosineSimilarity(queryEmbedding, chunk.embedding),
    }));

    // Sort by score descending and take topK
    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(0, topK).map(({ embedding, ...rest }) => rest);

    postResult("searchComplete", { results });
  } catch (error) {
    console.error("Search failed:", error);
    postResult("searchError", { error: error.message });
  }
}

/**
 * Get database stats
 */
async function handleGetStats() {
  try {
    const chunks = await getAllChunks();

    postResult("statsComplete", {
      chunkCount: chunks.length,
      totalTokens: chunks.reduce(
        (sum, c) => sum + (c.text?.length || 0) / 4,
        0,
      ),
    });
  } catch (error) {
    postResult("statsError", { error: error.message });
  }
}

/**
 * Clear all data
 */
async function handleClear() {
  try {
    await clearAllChunks();
    postResult("clearComplete", { success: true });
  } catch (error) {
    postResult("clearError", { error: error.message });
  }
}

/**
 * Initialize the worker
 */
async function init() {
  try {
    await openIdb();
    // Model will be loaded lazily on first embed request
    postResult("ready");
  } catch (error) {
    console.error("Worker init error:", error);
    postResult("initError", { error: error.message });
  }
}

/**
 * Handle incoming messages
 */
self.onmessage = async (event) => {
  const { type, ...data } = event.data;

  try {
    switch (type) {
      case "init":
        await init();
        break;

      case "storeChunks":
        await handleStoreChunks(data.chunks);
        break;

      case "search":
        await handleSearch(data.query, data.topK);
        break;

      case "getStats":
        await handleGetStats();
        break;

      case "clear":
        await handleClear();
        break;

      default:
        console.warn("Unknown message type:", type);
    }
  } catch (error) {
    console.error("Worker error:", error);
    postResult("error", { error: error.message, originalType: type });
  }
};

// Worker is initialized on-demand via 'init' message
// No auto-initialization to prevent loading embeddings until needed
