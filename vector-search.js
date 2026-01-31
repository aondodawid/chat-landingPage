import { getAuth, onAuthStateChanged } from "firebase/auth";
import {
  collection,
  getDocs,
  query,
  orderBy,
  limit,
  writeBatch,
  doc,
  serverTimestamp,
  vector,
} from "firebase/firestore";
import { app } from "../firebase-init.js";
import { firestore } from "../firebase-firestore.js";

const LLM_ENDPOINT = "https://model.makewebfast.online/v1/chat/completions";

const GLOBAL_WORKER_KEY = "__chatforge_vector_worker__";
const GLOBAL_INIT_KEY = "__chatforge_vector_search_init__";

let worker = null;

function isVectorDebugEnabled() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("debugVector") === "1") return true;
    return (
      window.localStorage && window.localStorage.getItem("debugVector") === "1"
    );
  } catch (e) {
    return false;
  }
}

function getWorker() {
  // Module-level singleton (fast path)
  if (worker) return worker;

  // Cross-module singleton: Astro can mount/execute the same script twice.
  // Using window-scoped storage ensures we don't spawn multiple Workers.
  const g = typeof window !== "undefined" ? window : null;
  if (g && g[GLOBAL_WORKER_KEY]) {
    worker = g[GLOBAL_WORKER_KEY];
    return worker;
  }

  worker = new Worker(new URL("./vector-db.worker.js", import.meta.url), {
    type: "module",
  });

  if (g) g[GLOBAL_WORKER_KEY] = worker;
  return worker;
}

/**
 * Step 1: Prepare local SQLite database (Embeddings) -> via Worker
 */
export function prepareLocalDatabase(
  userId,
  text,
  sourceName,
  onProgress,
  onStatus,
  clearExisting = true,
) {
  return new Promise((resolve, reject) => {
    const w = getWorker();

    // Set up one-time listener for this operation sequence
    const handler = (e) => {
      const msg = e.data;
      if (msg.type === "progress") {
        if (onProgress) onProgress(msg.completed, msg.total);
      } else if (msg.type === "opfs_unavailable") {
        if (onStatus) {
          const reasonText =
            msg.reason === "crossOriginIsolated-false"
              ? "OPFS wymaga COOP/COEP (crossOriginIsolated=false)."
              : "OPFS niedostępny w tej przeglądarce.";
          const fallbackText =
            msg.fallback === "indexeddb"
              ? "Używam trwałego zapisu IndexedDB."
              : "Używam tymczasowej bazy.";
          onStatus(`${reasonText} ${fallbackText}`);
        }
      } else if (msg.type === "done_prepare") {
        w.removeEventListener("message", handler);
        resolve();
      } else if (msg.type === "error") {
        w.removeEventListener("message", handler);
        reject(new Error(msg.error));
      }
    };

    w.addEventListener("message", handler);
    w.postMessage({
      action: "prepare",
      payload: { userId, text, sourceName, clearExisting },
    });
  });
}

async function getLocalStats(userId) {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    const handler = (e) => {
      if (e.data.type === "local_stats") {
        w.removeEventListener("message", handler);
        resolve({
          count: e.data.count || 0,
          bytes: e.data.bytes || 0,
        });
      } else if (e.data.type === "error") {
        w.removeEventListener("message", handler);
        reject(new Error(e.data.error));
      }
    };
    w.addEventListener("message", handler);
    w.postMessage({ action: "get_local_stats", payload: { userId } });
  });
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const idx = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / Math.pow(1024, idx);
  return `${value.toFixed(value >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function computeDotProduct(vecA, vecB) {
  let dot = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * (vecB[i] || 0);
  }
  return dot;
}

/**
 * Step 2: Upload completed local embeddings to Firestore.
 */
export async function uploadToFirestore(userId, onProgress) {
  // 1. Get data from worker
  const rows = await getLocalCompletedChunks(userId);

  // 2. Upload to Firestore (Main Thread)
  const baseCollection = collection(
    firestore,
    "users",
    userId,
    "trainingVectors",
  );
  const time = serverTimestamp();

  for (let i = 0; i < rows.length; i += 400) {
    const batch = writeBatch(firestore);
    const slice = rows.slice(i, i + 400);
    for (const r of slice) {
      const ref = doc(baseCollection);
      const vecArr = Array.from(new Float32Array(r.embedding)); // Ensure it's an array
      batch.set(ref, {
        sourceFileName: r.sourceName,
        chunkIndex: r.chunkIndex,
        text: r.text,
        embedding: vector(vecArr),
        createdAt: time,
      });
    }
    await batch.commit();
    if (onProgress) onProgress(i + slice.length, rows.length);
  }
}

async function getLocalCompletedChunks(userId) {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    const handler = (e) => {
      if (e.data.type === "completed_chunks") {
        w.removeEventListener("message", handler);
        resolve(e.data.rows || []);
      } else if (e.data.type === "error") {
        w.removeEventListener("message", handler);
        reject(new Error(e.data.error));
      }
    };
    w.addEventListener("message", handler);
    w.postMessage({ action: "get_upload_data", payload: { userId } });
  });
}

/**
 * Embed query via Worker
 */
async function embedText(text) {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    const handler = (e) => {
      if (e.data.type === "embed_result") {
        w.removeEventListener("message", handler);
        resolve(e.data.vector);
      } else if (e.data.type === "error") {
        w.removeEventListener("message", handler);
        reject(new Error(e.data.error));
      }
    };
    w.addEventListener("message", handler);
    w.postMessage({ action: "embed_query", payload: { text } });
  });
}

/**
 * Search local vector DB via Worker
 */
export async function searchLocalVectors(userId, vectorArray, topK) {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    const handler = (e) => {
      if (e.data.type === "search_results") {
        w.removeEventListener("message", handler);
        resolve(e.data.results || []);
      } else if (e.data.type === "error") {
        w.removeEventListener("message", handler);
        reject(new Error(e.data.error));
      }
    };
    w.addEventListener("message", handler);
    w.postMessage({
      action: "search_vectors",
      payload: { userId, vector: vectorArray, topK },
    });
  });
}

/**
 * Testing: Search Firestore + Local LLM call
 */
async function performSearchAndLLM(userId, queryStr, topK, onStream) {
  const queryEmbedding = await embedText(queryStr);
  console.log("Query Embedding:", queryEmbedding);

  // Prefer local DB first (SQLite in worker). If local data exists, this avoids Firestore reads
  // and matches the expected behavior: local results should survive refresh via IndexedDB/OPFS.
  let source = "local";
  const queryVec = queryEmbedding;
  const queryTerms = queryStr
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3);

  // 1) Fast local vector search (vec0)
  let results = [];
  try {
    const vec0Results = await searchLocalVectors(
      userId,
      Array.from(queryVec),
      topK,
    );

    if (vec0Results && vec0Results.length > 0) {
      results = vec0Results.map((r) => ({
        ...r,
        // vec_distance_cosine returns distance (lower is better).
        score: 1 - (r.distance || 0),
      }));
      console.log("Vector Search Results (Local SQLite vec0):", results);
    }
  } catch (e) {
    console.warn("Local vec0 search failed:", e);
  }

  // 2) Fallback to local scan if vec0 returned nothing
  if (results.length === 0) {
    try {
      const localRows = await getLocalCompletedChunks(userId);
      if (localRows.length > 0) {
        const scoredLocal = localRows
          .map((cand) => {
            const vec = Array.isArray(cand.embedding) ? cand.embedding : [];
            if (!vec.length) return { ...cand, score: -1 };
            const dot = computeDotProduct(queryVec, vec);

            const textLower = String(cand.text || "").toLowerCase();
            let keywordHits = 0;
            for (const term of queryTerms) {
              if (textLower.includes(term)) keywordHits += 1;
            }
            return { ...cand, score: dot + keywordHits * 0.15 };
          })
          .sort((a, b) => b.score - a.score);

        results = scoredLocal.slice(0, topK);
        console.log("Vector Search Results (Local SQLite Slow Scan):", results);
      }
    } catch (e) {
      console.warn("Local scan failed:", e);
    }
  }

  // If we found local results, skip Firestore entirely.
  if (results.length > 0) {
    const keywordResults = results.filter((r) => {
      const textLower = String(r.text || "").toLowerCase();
      return queryTerms.some((term) => textLower.includes(term));
    });

    const contextSource = keywordResults.length ? keywordResults : results;
    const context = contextSource.map((r) => r.text).join("\n\n---\n\n");
    const prompt = `Jesteś asystentem RAG. Odpowiadaj WYŁĄCZNIE na podstawie KONTEKSTU i krótko (2-4 zdania). Jeśli w KONTEKST nie ma odpowiedzi, napisz: "Brak informacji w bazie".
KONTEKST:\n${context}\n\nPYTANIE: ${queryStr}`;

    console.log("Calling local LLM...");

    const response = await fetch(LLM_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userId}`,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: prompt }],
        stream: Boolean(onStream),
      }),
    });

    if (onStream && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let fullText = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") {
            return { results, llmText: fullText, source };
          }
          try {
            const json = JSON.parse(data);
            const delta =
              json.choices?.[0]?.delta?.content ??
              json.choices?.[0]?.message?.content ??
              "";
            if (delta) {
              fullText += delta;
              onStream(fullText);
            }
          } catch {
            // ignore partial JSON
          }
        }
      }

      return {
        results,
        llmText: fullText || "Brak odpowiedzi od LLM.",
        source,
      };
    }

    const fullResponse = await response.json();
    console.log("Full LLM Response:", fullResponse);

    return {
      results,
      llmText:
        fullResponse.choices?.[0]?.message?.content ||
        "Brak odpowiedzi od LLM.",
      source,
    };
  }

  // 3) Firestore fallback
  source = "firestore";

  // Firestore Vector Search
  const baseCollection = collection(
    firestore,
    "users",
    userId,
    "trainingVectors",
  );

  // Fallback: Client-side vector search because "vectorDistance" export
  // is missing in the installed Firebase SDK version.
  // We fetch reasonably recent chunks and sort in memory.
  // In production with millions of rows, you would use a dedicated vector DB
  // or ensure the managed Firestore Vector Search is enabled and SDK is compatible.

  const q = query(baseCollection, orderBy("createdAt", "desc"), limit(100));

  const snap = await getDocs(q);
  const candidates = snap.docs.map((d) => d.data());

  const scored = candidates.map((cand) => {
    // cand.embedding is a VectorValue. .values() or .toArray() might give the array?
    // Actually the Firestore `vector()` type returns an object.
    // We stored it using `vector(...)`.
    // When retrieving, we get a VectorValue object. JS custom object.
    // It usually has a .toArray() method or .values property.
    // Let's safe check: if it's an array, use it; if object, try to convert.
    let vec = cand.embedding;
    if (vec && typeof vec.toArray === "function") {
      vec = vec.toArray();
    } else if (vec && Array.isArray(vec.values)) {
      vec = vec.values;
    }

    if (!Array.isArray(vec)) return { ...cand, score: -1 };

    // Dot product
    const dot = computeDotProduct(queryVec, vec);

    // Keyword boost (lightweight lexical rerank)
    const textLower = String(cand.text || "").toLowerCase();
    let keywordHits = 0;
    for (const term of queryTerms) {
      if (textLower.includes(term)) keywordHits += 1;
    }
    const boosted = dot + keywordHits * 0.15;
    return { ...cand, score: boosted };
  });

  // Sort descending by score
  scored.sort((a, b) => b.score - a.score);

  results = scored.slice(0, topK);
  console.log("Vector Search Results (Client-Side):", results);

  // Ensure we include any chunk that explicitly mentions the query terms
  const mustInclude = scored
    .filter((r) => {
      const textLower = String(r.text || "").toLowerCase();
      return queryTerms.some((term) => textLower.includes(term));
    })
    .slice(0, 2);

  const uniqueResults = new Map();
  for (const r of [...mustInclude, ...results]) {
    uniqueResults.set(`${r.sourceName}-${r.chunkIndex}`, r);
  }
  results = Array.from(uniqueResults.values()).slice(0, topK);

  // Note: no fallback to local here anymore; local is tried first above.

  const keywordResults = results.filter((r) => {
    const textLower = String(r.text || "").toLowerCase();
    return queryTerms.some((term) => textLower.includes(term));
  });

  const contextSource = keywordResults.length ? keywordResults : results;
  const context = contextSource.map((r) => r.text).join("\n\n---\n\n");
  const prompt = `Jesteś asystentem RAG. Odpowiadaj WYŁĄCZNIE na podstawie KONTEKSTU i krótko (2-4 zdania). Jeśli w KONTEKST nie ma odpowiedzi, napisz: "Brak informacji w bazie".
KONTEKST:\n${context}\n\nPYTANIE: ${queryStr}`;

  console.log("Calling local LLM...");

  const response = await fetch(LLM_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${userId}`,
    },
    body: JSON.stringify({
      messages: [{ role: "user", content: prompt }],
      stream: Boolean(onStream),
    }),
  });

  if (onStream && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let fullText = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") {
          return { results, llmText: fullText, source };
        }
        try {
          const json = JSON.parse(data);
          const delta =
            json.choices?.[0]?.delta?.content ??
            json.choices?.[0]?.message?.content ??
            "";
          if (delta) {
            fullText += delta;
            onStream(fullText);
          }
        } catch {
          // ignore partial JSON
        }
      }
    }

    return { results, llmText: fullText || "Brak odpowiedzi od LLM.", source };
  }

  const fullResponse = await response.json();
  console.log("Full LLM Response:", fullResponse);

  return {
    results,
    llmText:
      fullResponse.choices?.[0]?.message?.content || "Brak odpowiedzi od LLM.",
    source,
  };
}

// UI Setup
export function initVectorSearchTester() {
  // Guard against double initialization when the script is evaluated twice.
  if (typeof window !== "undefined") {
    if (window[GLOBAL_INIT_KEY]) return;
    window[GLOBAL_INIT_KEY] = true;
  }

  // Preload model immediately on page load
  const worker = getWorker();
  const debug = isVectorDebugEnabled();

  if (debug) {
    console.log("[vector-search debug] enabled");
    console.log(
      "[vector-search debug] SW controller:",
      navigator.serviceWorker ? navigator.serviceWorker.controller : null,
    );
    console.log(
      "[vector-search debug] crossOriginIsolated:",
      window.crossOriginIsolated,
    );
  }

  // Enable worker-side debug logging (posts back `type: 'debug'`).
  try {
    worker.postMessage({
      action: "set_debug",
      payload: { enabled: debug, echoToConsole: false },
    });
  } catch (e) {
    if (debug) console.warn("[vector-search debug] set_debug failed", e);
  }

  // Persistent logger for worker messages (safe: does not affect existing one-off handlers)
  if (debug && !worker.__vectorDebugListenerAttached) {
    worker.__vectorDebugListenerAttached = true;
    worker.addEventListener("message", (e) => {
      const msg = e.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "debug") {
        console.log("[vector-worker debug msg]", msg.event, msg);
      } else if (msg.type === "debug_state") {
        console.log("[vector-worker] debug_state", msg);
      } else if (msg.type === "idb_rehydrate_done") {
        console.log("[vector-worker] idb_rehydrate_done", msg);
      } else if (msg.type === "opfs_unavailable") {
        console.log("[vector-worker] opfs_unavailable", msg);
      } else if (msg.type === "error") {
        console.warn("[vector-worker] error", msg);
      }
    });
  }

  worker.postMessage({ action: "preload", payload: {} });

  const inputEl = document.getElementById("vector-search-input");
  const searchBtn = document.getElementById("vector-search-btn");
  const resultsEl = document.getElementById("vector-search-results");
  const statusEl = document.getElementById("vector-search-status");
  const trainingStatusEl = document.getElementById("training-status");
  const progressEl = document.getElementById("training-progress");
  const progressBarEl = document.getElementById("training-progress-bar");
  const localInfoEl = document.getElementById("training-local-info");

  // Top buttons in training.astro
  const prepareBtnTop = document.getElementById("vector-prepare-btn-top");
  // Main upload button at bottom
  const uploadBtnMain = document.getElementById("vector-upload-btn-main");

  // Hook into training inputs if present
  const trainingTextEl = document.getElementById("training-text");
  const trainingTitleEl = document.getElementById("training-text-title");
  const fileInput = document.getElementById("training-file");
  const fileNameDisplay = document.getElementById("training-file-name");

  const auth = getAuth(app);
  let currentUser = null;

  // Listen for OPFS status and other worker messages to update UI state
  worker.addEventListener("message", (e) => {
    if (e.data.type === "opfs_unavailable") {
      if (localInfoEl) {
        const fallbackText =
          e.data.fallback === "indexeddb"
            ? "Używam trwałego zapisu IndexedDB. Dane nie znikną po odświeżeniu."
            : "Dane znikną po odświeżeniu strony.";
        localInfoEl.innerHTML =
          `<span class="text-warning font-bold block mb-1">ℹ️ OPFS niedostępny</span>` +
          `Twoja przeglądarka nie obsługuje OPFS (wymagane nagłówki COOP/COEP). ` +
          fallbackText;
      }
    } else if (e.data.type === "idb_rehydrate_done") {
      // After refresh, the worker may rehydrate SQLite from IndexedDB.
      // Refresh UI stats once that completes.
      if (currentUser) refreshLocalStats(true);
    } else if (e.data.type === "init_done") {
      // Worker ready - we can try to fetch stats again if user is logged in
      if (currentUser) refreshLocalStats(true);
    }
  });

  const applyLocalStatsToUI = (stats, withStatus = false) => {
    const count = stats?.count || 0;
    const bytes = stats?.bytes || 0;

    if (localInfoEl) {
      // Check if we are showing an OPFS warning. If so, append stats, don't overwrite.
      const isWarning = localInfoEl.textContent.includes("brak OPFS");

      if (count > 0) {
        if (uploadBtnMain) uploadBtnMain.classList.remove("hidden");

        const message = `Lokalna baza: ${count} chunków, rozmiar ~${formatBytes(bytes)}. Dane gotowe do użycia.`;
        if (isWarning) {
          if (!localInfoEl.textContent.includes("Lokalna baza")) {
            localInfoEl.innerHTML += `<br/><span class="text-success mt-1 block">${message}</span>`;
          }
        } else {
          localInfoEl.textContent = message;
        }
      } else {
        if (uploadBtnMain) uploadBtnMain.classList.add("hidden");
        if (!isWarning) {
          localInfoEl.textContent = "Brak zapisanych danych w lokalnej bazie.";
        }
      }
    }

    // Only update progress/status bars if specifically requested (e.g. during process or major refresh)
    // Avoid clearing them if they show "Completed" status unless count is 0
    if (withStatus) {
      if (progressBarEl) {
        progressBarEl.value = count ? 100 : 0;
      }
      if (trainingStatusEl) {
        trainingStatusEl.textContent = count
          ? `Załadowano lokalnie (${formatBytes(bytes)}). Możesz używać bazy.`
          : "Brak lokalnych embeddingów. Przygotuj nowe dane.";
      }
      if (progressEl) {
        progressEl.textContent = count
          ? `Gotowe w SQLite (${formatBytes(bytes)}).`
          : "";
      }
    }
  };

  const refreshLocalStats = async (withStatus = false) => {
    if (!currentUser) return;
    try {
      const stats = await getLocalStats(currentUser.uid);
      // Force update UI if we found data, ensuring buttons appear
      const hasData = stats.count > 0;
      applyLocalStatsToUI(stats, withStatus || hasData);
    } catch (e) {
      console.warn("Error fetching stats:", e);
      if (localInfoEl) {
        localInfoEl.textContent = `Błąd odczytu bazy: ${e.message}`;
      }
    }
  };

  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    if (statusEl && !user) statusEl.textContent = "Zaloguj się.";
    if (trainingStatusEl && !user)
      trainingStatusEl.textContent = "Zaloguj się.";
    if (!user && localInfoEl) {
      localInfoEl.textContent = "";
    }
    if (user) {
      refreshLocalStats(true);

      if (debug) {
        try {
          worker.postMessage({
            action: "debug_get_state",
            payload: { userId: currentUser.uid },
          });
        } catch (e) {
          console.warn("[vector-search debug] debug_get_state failed", e);
        }
      }
    }
  });

  if (fileInput) {
    fileInput.addEventListener("change", () => {
      if (fileNameDisplay && fileInput.files?.[0]) {
        fileNameDisplay.textContent = fileInput.files[0].name;
      }
    });
  }

  const setProgress = (curr, total, message) => {
    const safeTotal = Math.max(1, total || 0);
    const percent = Math.min(100, Math.round((curr / safeTotal) * 100));

    if (progressEl && message) progressEl.textContent = message;
    if (progressBarEl) progressBarEl.value = percent;
    if (trainingStatusEl && message) trainingStatusEl.textContent = message;
  };

  const handlePrepare = async () => {
    if (!currentUser) return alert("Zaloguj się!");

    let text = trainingTextEl?.value || inputEl?.value;
    let title = trainingTitleEl?.value || "manual-entry";

    const file = fileInput?.files?.[0];
    if (file && !trainingTextEl?.value) {
      text = await file.text();
      title = file.name;
    }

    if (!text) return alert("Brak tekstu do przygotowania!");

    setProgress(0, 1, "Czyszczenie poprzednich danych...");
    try {
      await prepareLocalDatabase(
        currentUser.uid,
        text,
        title,
        (curr, total) => {
          setProgress(curr, total, `Postęp: ${curr}/${total}`);
        },
        (message) => {
          if (trainingStatusEl) trainingStatusEl.textContent = message;
          if (progressEl) progressEl.textContent = message;
        },
        true,
      );
      await refreshLocalStats(true);
      if (trainingStatusEl) {
        trainingStatusEl.textContent =
          "Gotowe w SQLite! Możesz teraz wysłać do Firestore.";
      }
    } catch (e) {
      setProgress(0, 1, `Błąd: ${e.message}`);
    }
  };

  const handleUpload = async () => {
    if (!currentUser) return alert("Zaloguj się!");
    setProgress(0, 1, "Przesyłanie do Firestore...");
    try {
      await uploadToFirestore(currentUser.uid, (curr, total) => {
        setProgress(curr, total, `Wysłano: ${curr}/${total}`);
      });
      setProgress(1, 1, "Wysłano pomyślnie!");
    } catch (e) {
      setProgress(0, 1, `Błąd: ${e.message}`);
    }
  };

  prepareBtnTop?.addEventListener("click", handlePrepare);
  uploadBtnMain?.addEventListener("click", handleUpload); // Use main bottom button

  async function runSearch() {
    if (!currentUser) return alert("Zaloguj się!");
    const queryStr = inputEl.value?.trim();
    if (!queryStr) return;

    // Add user message
    const uMsg = document.createElement("div");
    uMsg.className =
      "bg-primary text-primary-content p-3 rounded-lg self-end mb-2 ml-10 text-sm";
    uMsg.innerText = queryStr;
    resultsEl.appendChild(uMsg);
    inputEl.value = "";
    resultsEl.scrollTop = resultsEl.scrollHeight;

    if (statusEl) statusEl.textContent = "Wyszukiwanie i generowanie...";
    try {
      const topK = 5; // Fixed to 5 as requested
      const aMsg = document.createElement("div");
      aMsg.className =
        "bg-base-100 text-base-content p-3 rounded-lg self-start mb-2 mr-10 text-sm shadow-sm";
      resultsEl.appendChild(aMsg);
      resultsEl.scrollTop = resultsEl.scrollHeight;

      const { results, llmText, source } = await performSearchAndLLM(
        currentUser.uid,
        queryStr,
        topK,
        (partial) => {
          aMsg.innerText = partial;
          resultsEl.scrollTop = resultsEl.scrollHeight;
        },
      );

      if (!aMsg.innerText) {
        aMsg.innerText = llmText;
      }

      const sourceLabel =
        source === "local" ? "Lokalna Baza" : "Chmura (Firestore)";
      const badgeClass = source === "local" ? "badge-success" : "badge-info";

      if (statusEl)
        statusEl.innerHTML = `Znaleziono ${results.length} wyników <span class="badge ${badgeClass} badge-sm ml-2">${sourceLabel}</span>.`;
    } catch (e) {
      console.error(e);
      if (statusEl) statusEl.textContent = `Błąd: ${e.message}`;
    }
  }

  searchBtn?.addEventListener("click", runSearch);
  inputEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      runSearch();
    }
  });
}
