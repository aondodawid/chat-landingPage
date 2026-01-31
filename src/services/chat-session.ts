/**
 * Chat Session Orchestrator
 * Coordinates LLM, memory store, and vector search for conversations
 */

import {
  generateResponse,
  streamResponse,
  type ChatMessage,
} from "./llm-client";
import {
  addMessage,
  getRecentMessages,
  getMemoryStats,
  type ConversationMessage,
} from "./memory-store";
import { archiveMessages, getRelevantContext } from "./vector-store";
import { TOKEN_LIMITS } from "../lib/token-utils";
import { WELCOME_MESSAGE } from "../lib/prompts";

export interface ChatSessionConfig {
  sessionId?: string;
  useContext?: boolean;
  onMessageAdded?: (message: ConversationMessage) => void;
  onEvicted?: (messages: ConversationMessage[]) => void;
}

export class ChatSession {
  private sessionId: string;
  private useContext: boolean;
  private onMessageAdded?: (message: ConversationMessage) => void;
  private onEvicted?: (messages: ConversationMessage[]) => void;
  private isInitialized = false;

  constructor(config: ChatSessionConfig = {}) {
    this.sessionId = config.sessionId || "default";
    this.useContext = config.useContext ?? true;
    this.onMessageAdded = config.onMessageAdded;
    this.onEvicted = config.onEvicted;
  }

  /**
   * Initialize the session (lazy - only when archiving is needed)
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    this.isInitialized = true;
    // Vector store worker is initialized on-demand when archiving messages
  }

  /**
   * Get the welcome message
   */
  getWelcomeMessage(): string {
    return WELCOME_MESSAGE;
  }

  /**
   * Send a user message and get a response
   */
  async sendMessage(
    userContent: string,
    onStream?: (partial: string) => void,
  ): Promise<string> {
    // Store user message
    const { message: userMsg, evicted: userEvicted } = await addMessage(
      "user",
      userContent,
      this.sessionId,
    );

    if (this.onMessageAdded) {
      this.onMessageAdded(userMsg);
    }

    // Archive evicted messages
    if (userEvicted.length > 0) {
      await archiveMessages(userEvicted);
      if (this.onEvicted) {
        this.onEvicted(userEvicted);
      }
    }

    // Get recent conversation for context window
    const recentMessages = await getRecentMessages(
      TOKEN_LIMITS.RESPONSE_BUFFER * 4, // Leave room for response
      this.sessionId,
    );

    // Convert to ChatMessage format
    const messages: ChatMessage[] = recentMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // Retrieve relevant context from archived messages if enabled
    let context: string | undefined;
    if (this.useContext) {
      try {
        context = await getRelevantContext(userContent);
      } catch (e) {
        console.warn("Context retrieval failed:", e);
      }
    }

    // Generate response
    let assistantContent: string;

    if (onStream) {
      let partial = "";
      assistantContent = await streamResponse(messages, context, (chunk) => {
        partial += chunk;
        onStream(partial);
      });
    } else {
      assistantContent = await generateResponse(messages, context);
    }

    // Store assistant response
    const { message: assistantMsg, evicted: assistantEvicted } =
      await addMessage("assistant", assistantContent, this.sessionId);

    if (this.onMessageAdded) {
      this.onMessageAdded(assistantMsg);
    }

    // Archive evicted messages
    if (assistantEvicted.length > 0) {
      await archiveMessages(assistantEvicted);
      if (this.onEvicted) {
        this.onEvicted(assistantEvicted);
      }
    }

    return assistantContent;
  }

  /**
   * Get conversation history
   */
  async getHistory(): Promise<ConversationMessage[]> {
    return getRecentMessages(undefined, this.sessionId);
  }

  /**
   * Get memory usage stats
   */
  async getStats(): Promise<{
    tokenTotal: number;
    messageCount: number;
    percentUsed: number;
  }> {
    return getMemoryStats();
  }
}

// Singleton session for simple usage
let defaultSession: ChatSession | null = null;

/**
 * Get the default chat session
 */
export function getDefaultSession(): ChatSession {
  if (!defaultSession) {
    defaultSession = new ChatSession();
  }
  return defaultSession;
}

/**
 * Quick send message using default session
 */
export async function chat(
  message: string,
  onStream?: (partial: string) => void,
): Promise<string> {
  const session = getDefaultSession();
  await session.initialize();
  return session.sendMessage(message, onStream);
}
