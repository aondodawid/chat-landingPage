/**
 * Embeddings Pipeline - Transformers.js with EmbeddingGemma
 * Handles local embedding generation with caching
 */

import {
  pipeline,
  env,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";

// Configure Transformers.js for browser
env.allowLocalModels = false;
env.useBrowserCache = true;
env.remoteHost = `${window.location.origin}/hf`;
env.remotePath = "";

const MODEL_ID = "onnx-community/embeddinggemma-300m-ONNX";
const EMBEDDING_DIM = 768;

let embedderPromise: Promise<FeatureExtractionPipeline> | null = null;
let isWebGPU = false;

/**
 * Check if WebGPU is available and suitable
 */
async function checkWebGPU(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.gpu) {
    return false;
  }

  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return false;

    // Check for sufficient resources
    const deviceMemory = (navigator as any).deviceMemory;
    if (deviceMemory && deviceMemory < 4) {
      console.log("[Embeddings] Low device memory, using WASM");
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Initialize and get the embedding pipeline
 */
export async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!embedderPromise) {
    embedderPromise = (async () => {
      const useWebGPU = await checkWebGPU();
      isWebGPU = useWebGPU;

      console.log(
        `[Embeddings] Loading model with ${useWebGPU ? "WebGPU" : "WASM"} backend...`,
      );

      const options = useWebGPU ? { device: "webgpu" as const } : undefined;
      const pipe = await pipeline("feature-extraction", MODEL_ID, options);

      console.log("[Embeddings] Model loaded successfully");
      return pipe;
    })();
  }
  return embedderPromise;
}

/**
 * Preload the embedding model (call early to warm cache)
 */
export async function preloadEmbedder(): Promise<void> {
  await getEmbedder();
}

/**
 * Generate embedding for a single text
 */
export async function embedText(text: string): Promise<Float32Array> {
  const embedder = await getEmbedder();

  const output = await embedder(text, {
    pooling: "mean",
    normalize: true,
  });

  // Convert to Float32Array
  if (output.data) {
    return new Float32Array(output.data as ArrayLike<number>);
  }

  if (Array.isArray(output)) {
    return new Float32Array(output.flat(2) as number[]);
  }

  throw new Error("Unexpected embedding output format");
}

/**
 * Generate embeddings for multiple texts (batched for efficiency)
 */
export async function embedTexts(
  texts: string[],
  onProgress?: (completed: number, total: number) => void,
): Promise<Float32Array[]> {
  const embedder = await getEmbedder();
  const results: Float32Array[] = [];

  // Process in small batches for WebGPU efficiency
  const batchSize = isWebGPU ? 8 : 1;

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);

    const outputs = await embedder(batch, {
      pooling: "mean",
      normalize: true,
    });

    // Handle batch output
    if (batch.length === 1) {
      const data = outputs.data || outputs;
      results.push(new Float32Array(data as ArrayLike<number>));
    } else {
      // Multi-text batch - need to split by embedding dimension
      const allData = (outputs.data || outputs) as ArrayLike<number>;
      for (let j = 0; j < batch.length; j++) {
        const start = j * EMBEDDING_DIM;
        const end = start + EMBEDDING_DIM;
        results.push(new Float32Array(Array.from(allData).slice(start, end)));
      }
    }

    if (onProgress) {
      onProgress(Math.min(i + batchSize, texts.length), texts.length);
    }

    // Yield to UI occasionally
    if (i % 16 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return results;
}

/**
 * Convert embedding to bytes for storage
 */
export function embeddingToBytes(embedding: Float32Array): Uint8Array {
  return new Uint8Array(
    embedding.buffer,
    embedding.byteOffset,
    embedding.byteLength,
  );
}

/**
 * Convert bytes back to embedding
 */
export function bytesToEmbedding(bytes: Uint8Array): Float32Array {
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/**
 * Calculate cosine similarity between two embeddings
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Get the embedding dimension
 */
export function getEmbeddingDim(): number {
  return EMBEDDING_DIM;
}
