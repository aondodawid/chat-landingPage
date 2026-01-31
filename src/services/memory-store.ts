/**
 * Memory Store - IndexedDB-based conversation memory
 * Stores active conversation window up to ~800k tokens
 */

import { openDB, type IDBPDatabase } from "idb";
import { v4 as uuidv4 } from "uuid";
import {
  estimateMessageTokens,
  calculateTotalTokens,
  TOKEN_LIMITS,
} from "../lib/token-utils";

const DB_NAME = "terapeuta-memory";
const DB_VERSION = 1;
const MESSAGES_STORE = "messages";
const META_STORE = "meta";

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  tokenCount: number;
  sessionId: string;
}

interface MemoryMeta {
  id: string;
  tokenTotal: number;
  messageCount: number;
  updatedAt: string;
  oldestMessageId: string | null;
  newestMessageId: string | null;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

/**
 * Initialize and get the database connection
 */
async function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // Messages store with indexes
        if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
          const messagesStore = db.createObjectStore(MESSAGES_STORE, {
            keyPath: "id",
          });
          messagesStore.createIndex("byCreatedAt", "createdAt");
          messagesStore.createIndex("bySessionId", "sessionId");
        }

        // Meta store for quick stats
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: "id" });
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Get current memory metadata
 */
async function getMeta(): Promise<MemoryMeta> {
  const db = await getDB();
  const meta = await db.get(META_STORE, "main");
  return (
    meta || {
      id: "main",
      tokenTotal: 0,
      messageCount: 0,
      updatedAt: new Date().toISOString(),
      oldestMessageId: null,
      newestMessageId: null,
    }
  );
}

/**
 * Update memory metadata
 */
async function updateMeta(updates: Partial<MemoryMeta>): Promise<void> {
  const db = await getDB();
  const current = await getMeta();
  await db.put(META_STORE, {
    ...current,
    ...updates,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Add a message to memory
 * Returns messages that were evicted (for archiving to vector DB)
 */
export async function addMessage(
  role: "user" | "assistant" | "system",
  content: string,
  sessionId: string = "default",
): Promise<{ message: ConversationMessage; evicted: ConversationMessage[] }> {
  const db = await getDB();
  const meta = await getMeta();

  const message: ConversationMessage = {
    id: uuidv4(),
    role,
    content,
    createdAt: new Date().toISOString(),
    tokenCount: estimateMessageTokens({ role, content }),
    sessionId,
  };

  // Check if we need to evict old messages
  const evicted: ConversationMessage[] = [];
  let newTokenTotal = meta.tokenTotal + message.tokenCount;

  if (newTokenTotal > TOKEN_LIMITS.ACTIVE_MEMORY) {
    // Get oldest messages to evict
    const allMessages = await db.getAllFromIndex(MESSAGES_STORE, "byCreatedAt");

    for (const oldMsg of allMessages) {
      if (newTokenTotal <= TOKEN_LIMITS.ACTIVE_MEMORY * 0.9) break; // Leave 10% buffer

      evicted.push(oldMsg);
      newTokenTotal -= oldMsg.tokenCount;
      await db.delete(MESSAGES_STORE, oldMsg.id);
    }
  }

  // Add the new message
  await db.add(MESSAGES_STORE, message);

  // Update metadata
  const allMessages = await db.getAllFromIndex(MESSAGES_STORE, "byCreatedAt");
  await updateMeta({
    tokenTotal: newTokenTotal,
    messageCount: allMessages.length,
    oldestMessageId: allMessages[0]?.id || null,
    newestMessageId: allMessages[allMessages.length - 1]?.id || null,
  });

  return { message, evicted };
}

/**
 * Get all messages in the active memory window
 */
export async function getMessages(
  sessionId?: string,
): Promise<ConversationMessage[]> {
  const db = await getDB();

  if (sessionId) {
    return db.getAllFromIndex(MESSAGES_STORE, "bySessionId", sessionId);
  }

  return db.getAllFromIndex(MESSAGES_STORE, "byCreatedAt");
}

/**
 * Get recent messages (for LLM context window)
 */
export async function getRecentMessages(
  maxTokens: number = 32000,
  sessionId?: string,
): Promise<ConversationMessage[]> {
  const allMessages = await getMessages(sessionId);

  // Start from most recent and work backwards
  const result: ConversationMessage[] = [];
  let tokenCount = 0;

  for (let i = allMessages.length - 1; i >= 0; i--) {
    const msg = allMessages[i];
    if (tokenCount + msg.tokenCount > maxTokens) break;
    result.unshift(msg);
    tokenCount += msg.tokenCount;
  }

  return result;
}

/**
 * Get memory statistics
 */
export async function getMemoryStats(): Promise<{
  tokenTotal: number;
  messageCount: number;
  percentUsed: number;
}> {
  const meta = await getMeta();
  return {
    tokenTotal: meta.tokenTotal,
    messageCount: meta.messageCount,
    percentUsed: (meta.tokenTotal / TOKEN_LIMITS.ACTIVE_MEMORY) * 100,
  };
}

/**
 * Clear all messages (for testing or reset)
 */
export async function clearMemory(): Promise<void> {
  const db = await getDB();
  await db.clear(MESSAGES_STORE);
  await updateMeta({
    tokenTotal: 0,
    messageCount: 0,
    oldestMessageId: null,
    newestMessageId: null,
  });
}

/**
 * Delete a specific session's messages
 */
export async function clearSession(sessionId: string): Promise<void> {
  const db = await getDB();
  const messages = await db.getAllFromIndex(
    MESSAGES_STORE,
    "bySessionId",
    sessionId,
  );

  for (const msg of messages) {
    await db.delete(MESSAGES_STORE, msg.id);
  }

  // Recalculate meta
  const remaining = await db.getAllFromIndex(MESSAGES_STORE, "byCreatedAt");
  const tokenTotal = calculateTotalTokens(remaining);

  await updateMeta({
    tokenTotal,
    messageCount: remaining.length,
    oldestMessageId: remaining[0]?.id || null,
    newestMessageId: remaining[remaining.length - 1]?.id || null,
  });
}
