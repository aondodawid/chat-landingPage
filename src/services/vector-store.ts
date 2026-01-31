/**
 * Vector Store Bridge - Connects memory store with vector DB worker
 * Handles archiving old messages and retrieving relevant context
 */

import { chunkText, TOKEN_LIMITS } from "../lib/token-utils";
import type { ConversationMessage } from "./memory-store";

let worker: Worker | null = null;
let workerReady = false;
let pendingCallbacks: Map<
  string,
  { resolve: (data: any) => void; reject: (err: Error) => void; type: string }
> = new Map();
let callId = 0;

/**
 * Get or create the vector DB worker
 */
function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(
      new URL("../workers/vector-db.worker.js", import.meta.url),
      {
        type: "module",
      },
    );

    worker.onmessage = (e) => {
      const { type, ...data } = e.data;

      if (type === "ready") {
        workerReady = true;
      }

      // Handle responses by matching type to pending calls
      for (const [id, callback] of pendingCallbacks.entries()) {
        // Match response type to request type
        const expectedResponseType = getResponseType(callback.type);
        if (
          type === expectedResponseType ||
          type === "error" ||
          type.endsWith("Error")
        ) {
          pendingCallbacks.delete(id);
          if (type === "error" || type.endsWith("Error")) {
            callback.reject(new Error(data.error || "Unknown error"));
          } else {
            callback.resolve(data);
          }
          break;
        }
      }
    };

    worker.onerror = (e) => {
      console.error("Vector worker error:", e);
    };
  }
  return worker;
}

/**
 * Get expected response type for a request type
 */
function getResponseType(requestType: string): string {
  const responseMap: Record<string, string> = {
    init: "ready",
    storeChunks: "storeComplete",
    search: "searchComplete",
    getStats: "statsComplete",
    clear: "clearComplete",
  };
  return responseMap[requestType] || `${requestType}Complete`;
}

/**
 * Send message to worker and wait for response
 */
function workerCall<T>(type: string, payload: any = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = String(++callId);
    pendingCallbacks.set(id, { resolve, reject, type });

    getWorker().postMessage({
      type,
      ...payload,
    });

    // Timeout after 60 seconds
    setTimeout(() => {
      if (pendingCallbacks.has(id)) {
        pendingCallbacks.delete(id);
        reject(new Error("Worker timeout"));
      }
    }, 60000);
  });
}

/**
 * Preload the worker (call early)
 */
export async function preloadVectorStore(): Promise<void> {
  getWorker().postMessage({ type: "init" });
}

/**
 * Archive evicted messages to vector DB
 */
export async function archiveMessages(
  messages: ConversationMessage[],
): Promise<void> {
  if (messages.length === 0) return;

  // Combine messages into text chunks
  const combinedText = messages
    .map((m) => `[${m.role}] ${m.content}`)
    .join("\n\n");

  const textChunks = chunkText(combinedText, TOKEN_LIMITS.ARCHIVE_CHUNK_SIZE);

  if (textChunks.length === 0) return;

  // Format chunks for worker
  const chunks = textChunks.map((text, index) => ({
    id: `conv_${Date.now()}_${index}`,
    source: "conversation",
    chunkIndex: index,
    text,
    createdAt: new Date().toISOString(),
  }));

  await workerCall("storeChunks", { chunks });
}

/**
 * Search for relevant context from archived messages
 */
export async function searchContext(
  query: string,
  topK: number = 5,
): Promise<{ text: string; score: number }[]> {
  const result = await workerCall<{ results: any[] }>("search", {
    query,
    topK,
  });

  return result.results.map((r) => ({
    text: r.text,
    score: r.score,
  }));
}

/**
 * Get context string for LLM injection
 */
export async function getRelevantContext(
  query: string,
  maxTokens: number = TOKEN_LIMITS.MAX_RETRIEVED_CONTEXT,
): Promise<string | undefined> {
  const results = await searchContext(query, 10);

  if (results.length === 0) return undefined;

  // Filter by minimum relevance score
  const relevant = results.filter((r) => r.score > 0.3);

  if (relevant.length === 0) return undefined;

  // Build context string within token limit
  let context = "";
  const charsPerToken = 3.5;
  const maxChars = maxTokens * charsPerToken;

  for (const result of relevant) {
    if (context.length + result.text.length > maxChars) break;
    context += result.text + "\n\n---\n\n";
  }

  return context.trim() || undefined;
}

/**
 * Get vector store statistics
 */
export async function getVectorStoreStats(): Promise<{
  chunkCount: number;
  totalTokens: number;
}> {
  const result = await workerCall<{ chunkCount: number; totalTokens: number }>(
    "getStats",
    {},
  );
  return result;
}

/**
 * Clear all archived data
 */
export async function clearVectorStore(): Promise<void> {
  await workerCall("clear", {});
}
