import { pipeline, env } from "@huggingface/transformers";
import { getAuth, onAuthStateChanged } from "firebase/auth";
import {
  collection,
  doc,
  getDocs,
  serverTimestamp,
  writeBatch,
  vector,
} from "firebase/firestore";
import { app } from "../firebase-init.js";
import { firestore } from "../firebase-firestore.js";

// Konfiguracja modelu i parametrów przetwarzania tekstu
const MODEL_ID = "onnx-community/embeddinggemma-300m-ONNX";
// Ustawienia dostrojone pod RAG dla Gemma 3: większe fragmenty + sensowny overlap
const DEFAULT_CHUNK_SIZE = 1200; // Długość fragmentu w znakach (ok. 700-900 tokenów)
const DEFAULT_OVERLAP = 200; // Zakładka między fragmentami dla zachowania kontekstu
const MAX_CHUNKS = 500; // Limit fragmentów na jedno źródło
const DEDUP_MIN_LENGTH = 80; // Minimalna długość, od której deduplikujemy fragmenty
const BATCH_WRITE_LIMIT = 450; // Limit bezpieczny dla Firestore batch
const EMBED_YIELD_EVERY = 1; // Jak często oddać sterowanie UI podczas embedowania
const SHORT_TEXT_THRESHOLD = 500; // Próg dla krótszych tekstów
const SHORT_CHUNK_SIZE = 400; // Mniejszy chunk dla krótkich tekstów
const SHORT_OVERLAP = 60; // Mniejszy overlap dla krótkich tekstów
const EMBED_CONCURRENCY = 2; // Ograniczona równoległość dla stabilności w przeglądarce
console.log("ok");
let embedderPromise = null;
let isProgressYielding = false;

// Konfiguracja Transformers.js dla przeglądarki
env.allowLocalModels = false;
// Używamy pamięci podręcznej przeglądarki, aby nie pobierać modelu przy każdym odświeżeniu
env.useBrowserCache = true;

/**
 * Ustawia tekst statusu w interfejsie użytkownika
 * (batched w requestAnimationFrame, aby nie blokować renderu paska postępu)
 */
const statusUpdateQueue = new Map();
let statusUpdateScheduled = false;

function flushStatusUpdates() {
  statusUpdateScheduled = false;
  statusUpdateQueue.forEach((text, node) => {
    if (node && node.textContent !== text) {
      node.textContent = text;
    }
  });
  statusUpdateQueue.clear();
}

function setStatus(el, message) {
  if (!el) return;
  const nextText = message ?? "";
  if (el.textContent === nextText) return;
  statusUpdateQueue.set(el, nextText);

  if (statusUpdateScheduled) return;
  statusUpdateScheduled = true;
  requestAnimationFrame(flushStatusUpdates);
}

function logProgress(stage, details = {}) {
  const timestamp = new Date().toLocaleTimeString("pl-PL");
  console.log(`[${timestamp}] [TRAINING] ${stage}`, details);
}

/**
 * Dzieli długi tekst na mniejsze fragmenty (chunks) z zakładką
 */
function normalizeText(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function redactPII(text) {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]")
    .replace(/\b\+?\d[\d\s().-]{7,}\d\b/g, "[PHONE]")
    .replace(/\bhttps?:\/\/\S+\b/gi, "[URL]")
    .replace(/\b\d{11}\b/g, "[ID]");
}

function getChunkConfig(text) {
  const length = text.length;
  if (length <= SHORT_TEXT_THRESHOLD) {
    return {
      maxLen: Math.min(SHORT_CHUNK_SIZE, DEFAULT_CHUNK_SIZE),
      overlap: Math.min(SHORT_OVERLAP, DEFAULT_OVERLAP),
    };
  }
  return { maxLen: DEFAULT_CHUNK_SIZE, overlap: DEFAULT_OVERLAP };
}

function findSentenceBoundary(text, start, end) {
  const windowStart = Math.max(start, end - 120);
  const window = text.slice(windowStart, end);
  const match = window.match(/([.!?]|\n)\s(?!.*[.!?]|\n)/);
  if (!match) return end;
  const idx = window.lastIndexOf(match[0]);
  const boundary = windowStart + idx + match[0].length;
  return boundary > start + 100 ? boundary : end;
}

function normalizeForDedup(text) {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Dzieli długi tekst na mniejsze fragmenty (chunks) z zakładką,
 * starając się nie ucinać w połowie zdania.
 */
function chunkText(
  text,
  maxLen = DEFAULT_CHUNK_SIZE,
  overlap = DEFAULT_OVERLAP,
) {
  const clean = normalizeText(text);
  if (!clean) return [];

  const chunks = [];
  const seen = new Set();
  let start = 0;

  while (start < clean.length && chunks.length < MAX_CHUNKS) {
    let end = Math.min(start + maxLen, clean.length);
    if (end < clean.length) {
      end = findSentenceBoundary(clean, start, end);
    }

    const slice = clean.slice(start, end).trim();
    if (slice) {
      if (slice.length >= DEDUP_MIN_LENGTH) {
        const key = normalizeForDedup(slice);
        if (!seen.has(key)) {
          seen.add(key);
          chunks.push(slice);
        }
      } else {
        chunks.push(slice);
      }
    }

    if (end === clean.length) break;
    start = Math.max(0, end - overlap);
  }

  return chunks;
}

async function embedChunksWithConcurrency(embedder, chunks, onProgress) {
  const results = new Array(chunks.length);
  let completed = 0;
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < chunks.length) {
      const index = nextIndex;
      nextIndex += 1;
      const vector = await embedText(embedder, chunks[index]);
      results[index] = vector;
      completed += 1;
      if (onProgress) await onProgress(completed, chunks.length);
      if (completed % EMBED_YIELD_EVERY === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  const workers = Array.from({ length: EMBED_CONCURRENCY }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Oblicza rozmiar modelu w pamięci
 */
function calculateModelSize(model) {
  let totalSize = 0;

  // Iteruj przez obiekty modelu, aby znaleźć tensory
  const traverse = (obj, depth = 0) => {
    if (depth > 5) return; // Limit głębokości rekurencji
    if (!obj || typeof obj !== "object") return;

    for (const [key, value] of Object.entries(obj)) {
      // Sprawdź czy to tensor z danymi
      if (value && typeof value === "object") {
        if (value.data && ArrayBuffer.isView(value.data)) {
          // To jest tensor
          totalSize += value.data.byteLength;
        } else if (Array.isArray(value.data)) {
          // Tablica liczb
          totalSize += value.data.length * 4; // Zakładając float32
        } else if (key !== "config" && typeof value === "object") {
          // Rekurencyjnie sprawdź zagnieżdżone obiekty
          traverse(value, depth + 1);
        }
      }
    }
  };

  traverse(model);

  const sizeMB = (totalSize / (1024 * 1024)).toFixed(2);
  const sizeGB = (totalSize / (1024 * 1024 * 1024)).toFixed(4);

  return { bytesTotal: totalSize, sizeMB, sizeGB };
}

/**
 * Inicjalizuje i pobiera potok (pipeline) do generowania embeddingów
 */
let modelLoadStartTime = null;
let modelInfo = null;

async function checkWebGPU() {
  // 1. Sprawdź czy API istnieje
  if (!navigator.gpu) {
    return false;
  }

  // 2. Spróbuj pobrać adapter (dostęp do karty graficznej)
  const adapter = await navigator.gpu.requestAdapter();

  if (!adapter) {
    return false;
  }

  return true;
}

checkWebGPU().then(console.log);

async function getEmbedder() {
  if (!embedderPromise) {
    const isWebGPU = await checkWebGPU();
    modelLoadStartTime = performance.now();
    if (isWebGPU) {
      embedderPromise = pipeline("feature-extraction", MODEL_ID, {
        device: "webgpu",
      });
    } else {
      embedderPromise = pipeline("feature-extraction", MODEL_ID);
    }

    // Pobierz informacje o modelu po załadowaniu
    embedderPromise.then((model) => {
      const loadTime = performance.now() - modelLoadStartTime;
      const { sizeMB, sizeGB } = calculateModelSize(model);

      logProgress("Model załadowany", {
        modelId: MODEL_ID,
        loadTimeMs: Math.round(loadTime),
        loadTimeSec: (loadTime / 1000).toFixed(2),
        memorySizeMB: `${sizeMB} MB`,
        memorySizeGB: `${sizeGB} GB`,
      });
    });
  }
  return embedderPromise;
}

/**
 * Convert output tensor to a plain JavaScript array (vector)
 */
function toVector(embedding) {
  // Transformers.js może zwrócić obiekt Tensor z polem .data lub zagnieżdżone tablice
  if (embedding && embedding.data) {
    return Array.from(embedding.data);
  }
  if (Array.isArray(embedding)) {
    return embedding.flat(2);
  }
  return [];
}

/**
 * Generuje wektor (embedding) dla podanego fragmentu tekstu
 */
async function embedText(embedder, text) {
  const output = await embedder(text, {
    pooling: "mean",
    normalize: true,
  });
  return toVector(output);
}

/**
 * Zapisuje wygenerowane fragmenty i ich wektory do Firestore w jednej paczce (batch)
 */
async function writeChunksToFirestore({ userId, fileName, chunks, vectors }) {
  const baseCollection = collection(
    firestore,
    "users",
    userId,
    "trainingVectors",
  );
  const createdAt = serverTimestamp();
  const model = MODEL_ID;

  // Usuń poprzednie dane użytkownika, aby przechowywać tylko jedno źródło
  const existing = await getDocs(baseCollection);
  if (!existing.empty) {
    logProgress("Usuwanie poprzednich danych", { count: existing.size });
    const docs = existing.docs;
    for (let i = 0; i < docs.length; i += BATCH_WRITE_LIMIT) {
      const batch = writeBatch(firestore);
      const end = Math.min(i + BATCH_WRITE_LIMIT, docs.length);
      for (let j = i; j < end; j += 1) {
        batch.delete(docs[j].ref);
      }
      await batch.commit();
    }
  }

  for (let i = 0; i < chunks.length; i += BATCH_WRITE_LIMIT) {
    const batch = writeBatch(firestore);
    const end = Math.min(i + BATCH_WRITE_LIMIT, chunks.length);

    for (let index = i; index < end; index += 1) {
      const ref = doc(baseCollection);
      // Ensure vector is a plain array of numbers
      const vecData = Array.isArray(vectors[index])
        ? vectors[index]
        : Array.from(vectors[index]);

      batch.set(ref, {
        sourceFileName: fileName,
        chunkIndex: index,
        totalChunks: chunks.length,
        text: chunks[index],
        embedding: vector(vecData),
        model,
        createdAt,
      });
    }

    await batch.commit();
  }
}

let progressBatch = null;
let progressRafId = null;

function flushProgress() {
  if (!progressBatch) return;
  const { value, message } = progressBatch;

  const progressEl = document.getElementById("training-progress");
  const progressBarEl = document.getElementById("training-progress-bar");

  if (progressEl) {
    if (message !== undefined && progressEl.textContent !== message) {
      progressEl.textContent = message;
    }
  }
  if (progressBarEl) {
    if (value !== undefined) {
      const safe = Number.isFinite(value)
        ? Math.max(0, Math.min(100, value))
        : 0;
      if (progressBarEl.value !== safe) {
        progressBarEl.value = safe;
      }
    }
  }
  progressBatch = null;
  progressRafId = null;
}

function setProgress(value, message) {
  // Update the pending state
  if (!progressBatch) {
    progressBatch = { value, message };
  } else {
    // Overwrite with latest
    progressBatch.value = value;
    progressBatch.message = message;
  }

  // Schedule render if not already scheduled
  if (!progressRafId) {
    progressRafId = requestAnimationFrame(flushProgress);
  }
}
/**
 * Inicjalizuje logikę przesyłania i trenowania plików w UI
 */
export function initTrainingUpload() {
  const statusEl = document.getElementById("training-status");
  const fileInput = document.getElementById("training-file");
  const uploadBtn = document.getElementById("training-upload-btn");
  const textInput = document.getElementById("training-text");
  const textTitleInput = document.getElementById("training-text-title");
  const textBtn = document.getElementById("training-text-btn");

  const fileNameEl = document.getElementById("training-file-name");
  const progressBarEl = document.getElementById("training-progress-bar");

  if (!fileInput || !uploadBtn) return;

  // Ukryj progress bar na początku
  if (progressBarEl) {
    progressBarEl.style.display = "none";
  }

  const auth = getAuth(app);
  let currentUser = null;

  // Śledzenie stanu zalogowania użytkownika
  onAuthStateChanged(auth, (user) => {
    currentUser = user;
  });

  // Wstępne ładowanie modelu w tle po wejściu na podstronę
  setTimeout(async () => {
    logProgress("Preload modelu rozpoczęty", { modelId: MODEL_ID });
    try {
      await getEmbedder();
      logProgress("Preload modelu zakończony", { modelId: MODEL_ID });
    } catch (error) {
      logProgress("BŁĄD: Preload modelu nieudany", { error });
    }
  }, 0);

  function estimateEmbeddingBytes(vectors) {
    const totalFloats = vectors.reduce(
      (sum, vector) => sum + (Array.isArray(vector) ? vector.length : 0),
      0,
    );
    return totalFloats * 4; // Float32
  }

  // Obsługa zmiany pliku (wyświetlenie nazwy)
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (fileNameEl) {
      fileNameEl.textContent = file ? file.name : "";
    }
  });

  async function processTrainingInput({ rawText, sourceName }) {
    // Nie pokazuj progress baru aż do momentu embedowania
    // setProgress(12, "Przygotowanie tekstu...");
    await new Promise((resolve) => setTimeout(resolve, 50)); // Krótkie opóźnienie dla UI

    const sanitizedText = redactPII(rawText);
    const chunkConfig = getChunkConfig(sanitizedText);
    const chunks = chunkText(
      sanitizedText,
      chunkConfig.maxLen,
      chunkConfig.overlap,
    );
    logProgress("Chunkowanie ukończone", {
      chunkCount: chunks.length,
      maxLen: chunkConfig.maxLen,
      overlap: chunkConfig.overlap,
      totalLength: sanitizedText.length,
      avgChunkSize: Math.round(sanitizedText.length / chunks.length),
    });

    if (!chunks.length) {
      logProgress("BŁĄD: Pusty tekst");
      setStatus(statusEl, "Tekst jest pusty lub zawiera tylko białe znaki.");
      setProgress(0, "");
      await new Promise((resolve) => setTimeout(resolve, 50)); // Krótkie opóźnienie dla UI

      return;
    }

    if (chunks.length >= MAX_CHUNKS) {
      logProgress("BŁĄD: Za dużo fragmentów", {
        chunks: chunks.length,
        max: MAX_CHUNKS,
      });
      setStatus(
        statusEl,
        `Źródło jest zbyt duże (limit ${MAX_CHUNKS} fragmentów). Skróć tekst.`,
      );
      setProgress(0, "");
      await new Promise((resolve) => setTimeout(resolve, 50)); // Krótkie opóźnienie dla UI
      return;
    }

    // Załadowanie modelu (może chwilę potrwać za pierwszym razem)
    // Nie pokazuj progress baru tutaj - zaczyna się od embedowania
    // setStatus(statusEl, "Ładowanie modelu - EmbeddingGemma...");
    await new Promise((resolve) => setTimeout(resolve, 100)); // Krótkie opóźnienie dla UI

    logProgress("Ładowanie modelu", { modelId: MODEL_ID });
    // setProgress(20, "Ładowanie modelu...");
    await new Promise((resolve) => setTimeout(resolve, 50)); // Krótkie opóźnienie dla UI

    let embedder;
    try {
      const modelLoadStart = performance.now();
      embedder = await getEmbedder();
      const modelLoadDuration = performance.now() - modelLoadStart;

      logProgress("Model gotowy do użytku", {
        modelId: MODEL_ID,
        loadTimeMs: Math.round(modelLoadDuration),
        loadTimeSec: (modelLoadDuration / 1000).toFixed(2),
      });
    } catch (err) {
      logProgress("BŁĄD: Nie udało się załadować modelu", { error: err });
      throw new Error(
        "Nie udało się pobrać lub uruchomić modelu AI. Spróbuj odświeżyć stronę.",
      );
    }

    logProgress("Rozpoczynam analizę fragmentów", { modelId: MODEL_ID });
    // Progress bar pojawia się dopiero tutaj - gdy zaczynamy embedowanie
    setProgress(22, "Analizuję treść: 0/0 fragmentów...");
    await new Promise((resolve) => setTimeout(resolve, 50)); // Krótkie opóźnienie dla UI
    const embedStart = performance.now();
    const vectors = await embedChunksWithConcurrency(
      embedder,
      chunks,
      async (done, total) => {
        const percent = Math.round(22 + (done / total) * 65); // 22% -> 87%
        // Wymuś odświeżenie statusu bezpośrednio (omijając debounce flushRaf)
        // dla ważnych kamieni milowych postępu
        setProgress(percent, `Analizuję treść: ${done}/${total} fragmentów...`);

        // Zawsze oddaj sterowanie event loop, aby UI mogło się przerysować
        await new Promise((resolve) =>
          requestAnimationFrame(() => setTimeout(resolve, 0)),
        );

        if (done % 10 === 0 || done === total) {
          logProgress("Postęp embedowania", { done, total });
        }
      },
    );
    const embedTime = performance.now() - embedStart;
    logProgress("Embedowanie ukończone", {
      vectorCount: vectors.length,
      timeMs: Math.round(embedTime),
      timePerVector: Math.round(embedTime / vectors.length),
    });

    // Zapis wszystkiego do bazy danych
    setStatus(statusEl, "Zapis do Firestore...");
    setProgress(90, "Zapis do Firestore...");
    await new Promise((resolve) => setTimeout(resolve, 50)); // Krótkie opóźnienie dla UI

    const writeStart = performance.now();
    await writeChunksToFirestore({
      userId: currentUser.uid,
      fileName: sourceName,
      chunks,
      vectors,
    });
    const writeTime = performance.now() - writeStart;
    logProgress("Zapis do Firestore ukończony", {
      chunkCount: chunks.length,
      timeMs: Math.round(writeTime),
    });

    const embeddingBytes = estimateEmbeddingBytes(vectors);
    logProgress("Rozmiar embeddingów", {
      bytes: embeddingBytes,
      kb: Math.round(embeddingBytes / 1024),
      mb: (embeddingBytes / (1024 * 1024)).toFixed(2),
    });

    setStatus(statusEl, "Gotowe! Dane zapisane w bazie wektorowej.");
    setProgress(100, "Zakończono.");
    await new Promise((resolve) => setTimeout(resolve, 50)); // Krótkie opóźnienie dla UI

    logProgress("SUKCES: Cały proces zakończony", {
      fileName: sourceName,
      totalChunks: chunks.length,
      totalVectors: vectors.length,
    });

    setTimeout(() => setProgress(0, ""), 1200);
  }

  // Główna logika po kliknięciu "Prześlij" (plik)
  uploadBtn.addEventListener("click", async () => {
    try {
      // Pokaż progress bar po kliknięciu
      if (progressBarEl) {
        progressBarEl.style.display = "block";
      }
      setProgress(1, "Przygotowanie...");

      await new Promise((resolve) => setTimeout(resolve, 50)); // Krótkie opóźnienie dla UI
      if (!currentUser) {
        setStatus(statusEl, "Musisz być zalogowany, aby trenować.");
        setProgress(0, "");
        await new Promise((resolve) => setTimeout(resolve, 50)); // Krótkie opóźnienie dla UI

        return;
      }

      const file = fileInput.files?.[0];
      if (!file) {
        setStatus(statusEl, "Wybierz plik .txt do wgrania.");
        setProgress(0, "");
        await new Promise((resolve) => setTimeout(resolve, 50)); // Krótkie opóźnienie dla UI

        return;
      }

      if (!file.name.toLowerCase().endsWith(".txt")) {
        setStatus(statusEl, "Obsługiwane są tylko pliki tekstowe .txt");
        setProgress(0, "");
        await new Promise((resolve) => setTimeout(resolve, 50)); // Krótkie opóźnienie dla UI

        return;
      }

      setStatus(statusEl, "Czytam plik...");
      // setProgress(12, "Czytam plik...");
      await new Promise((resolve) => setTimeout(resolve, 50)); // Krótkie opóźnienie dla UI

      const rawText = await file.text();
      logProgress("Plik wczytany", { fileName: file.name, size: file.size });
      await processTrainingInput({ rawText, sourceName: file.name });

      // Reset UI po zakończeniu
      fileInput.value = "";
      if (fileNameEl) fileNameEl.textContent = "";
    } catch (error) {
      console.error("Błąd podczas przesyłania pliku:", error);
      setStatus(statusEl, `Błąd: ${error.message}`);
      setProgress(0, "");
      await new Promise((resolve) => setTimeout(resolve, 50)); // Krótkie opóźnienie dla UI
    }
  });

  // Logika po kliknięciu "Zapisz tekst" (ręczny input)
  if (textBtn && textInput) {
    textBtn.addEventListener("click", async () => {
      try {
        // Pokaż progress bar po kliknięciu
        if (progressBarEl) {
          progressBarEl.style.display = "block";
        }
        setProgress(1, "Przygotowanie...");
        await new Promise((resolve) => setTimeout(resolve, 50)); // Krótkie opóźnienie dla UI

        if (!currentUser) {
          setStatus(statusEl, "Musisz być zalogowany, aby trenować.");
          setProgress(0, "");
          await new Promise((resolve) => setTimeout(resolve, 50)); // Krótkie opóźnienie dla UI

          return;
        }

        const rawText = textInput.value || "";
        if (!rawText.trim()) {
          setStatus(statusEl, "Wprowadź tekst do trenowania.");
          setProgress(0, "");
          await new Promise((resolve) => setTimeout(resolve, 50)); // Krótkie opóźnienie dla UI
          return;
        }
        // setProgress(12, "Przygotowanie tekstu...");
        await new Promise((resolve) => setTimeout(resolve, 50)); // Krótkie opóźnienie dla UI

        logProgress("Tekst ręczny wczytany", { size: rawText.length });

        const customTitle = textTitleInput?.value?.trim();
        const sourceName = customTitle || "manual-text";

        logProgress("Rozpoczęcie przetwarzania tekstu", { sourceName });
        // setProgress(12, "Przygotowanie tekstu...");
        await new Promise((resolve) => setTimeout(resolve, 50)); // Krótkie opóźnienie dla UI

        await processTrainingInput({ rawText, sourceName });

        textInput.value = "";
        if (textTitleInput) textTitleInput.value = "";
      } catch (error) {
        console.error("Błąd podczas przetwarzania tekstu:", error);
        setStatus(statusEl, `Błąd: ${error.message}`);
        setProgress(0, "");
        await new Promise((resolve) => setTimeout(resolve, 50)); // Krótkie opóźnienie dla UI
      }
    });
  }
}
