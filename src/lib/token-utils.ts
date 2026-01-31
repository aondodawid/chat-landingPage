/**
 * Token estimation utilities
 * Simple heuristic-based token counting for memory management
 */

// Average characters per token for Polish text (slightly higher than English)
const CHARS_PER_TOKEN = 3.5;

/**
 * Estimate token count from text
 * Uses character-based heuristic suitable for Polish text
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimate tokens for a message object
 */
export function estimateMessageTokens(message: {
  role: string;
  content: string;
}): number {
  // Add overhead for role and message structure (~4 tokens)
  return estimateTokens(message.content) + 4;
}

/**
 * Calculate total tokens for an array of messages
 */
export function calculateTotalTokens(
  messages: { role: string; content: string }[],
): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}

/**
 * Memory limits (in tokens)
 */
export const TOKEN_LIMITS = {
  // Active memory window (IndexedDB) - 800k tokens as per spec
  ACTIVE_MEMORY: 800_000,

  // Chunk size for archiving to vector DB
  ARCHIVE_CHUNK_SIZE: 500,

  // Overlap between chunks for context continuity
  ARCHIVE_OVERLAP: 50,

  // Maximum context to retrieve from vector DB
  MAX_RETRIEVED_CONTEXT: 4000,

  // Buffer to leave for response generation
  RESPONSE_BUFFER: 8000,
};

/**
 * Check if adding a message would exceed the active memory limit
 */
export function wouldExceedLimit(
  currentTokens: number,
  newMessage: { role: string; content: string },
): boolean {
  const newTokens = estimateMessageTokens(newMessage);
  return currentTokens + newTokens > TOKEN_LIMITS.ACTIVE_MEMORY;
}

/**
 * Chunk text into smaller pieces for vector storage
 */
export function chunkText(
  text: string,
  maxTokens = TOKEN_LIMITS.ARCHIVE_CHUNK_SIZE,
): string[] {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const overlapChars = TOKEN_LIMITS.ARCHIVE_OVERLAP * CHARS_PER_TOKEN;

  if (text.length <= maxChars) {
    return [text];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = start + maxChars;

    // Try to break at sentence boundary
    if (end < text.length) {
      const lastPeriod = text.lastIndexOf(".", end);
      const lastNewline = text.lastIndexOf("\n", end);
      const breakPoint = Math.max(lastPeriod, lastNewline);

      if (breakPoint > start + maxChars * 0.5) {
        end = breakPoint + 1;
      }
    }

    chunks.push(text.slice(start, end).trim());
    start = end - overlapChars;

    if (start >= text.length) break;
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const idx = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / Math.pow(1024, idx);
  return `${value.toFixed(value >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

/**
 * Format token count to human-readable string
 */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}
