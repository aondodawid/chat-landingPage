/**
 * LLM Client for Gemini Flash via LangChain
 * Configured for maximum quality responses for psycholog-seksuolog assistant
 */

import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { SYSTEM_PROMPT } from "../lib/prompts";

// Get API key from environment (injected at build time)
const GEMINI_API_KEY = import.meta.env.PUBLIC_GEMINI_API_KEY || "";

// Model configuration for maximum intelligence
const MODEL_CONFIG = {
  modelName: "gemini-2.0-flash", // Latest flash model
  temperature: 0.2, // Low randomness for consistent, thoughtful responses
  topP: 0.95, // High diversity within low temperature
  maxOutputTokens: 8192, // Maximum output for detailed responses
  apiKey: GEMINI_API_KEY,
};

let llmInstance: ChatGoogleGenerativeAI | null = null;

/**
 * Get or create the LLM instance
 */
export function getLLM(): ChatGoogleGenerativeAI {
  if (!llmInstance) {
    if (!GEMINI_API_KEY) {
      throw new Error(
        "GEMINI_API_KEY is not configured. Set PUBLIC_GEMINI_API_KEY environment variable.",
      );
    }
    llmInstance = new ChatGoogleGenerativeAI(MODEL_CONFIG);
  }
  return llmInstance;
}

/**
 * Message role types
 */
export type MessageRole = "user" | "assistant" | "system";

/**
 * Chat message interface
 */
export interface ChatMessage {
  role: MessageRole;
  content: string;
}

/**
 * Convert our message format to LangChain messages
 */
function toBaseMessages(messages: ChatMessage[]): BaseMessage[] {
  return messages.map((msg) => {
    switch (msg.role) {
      case "user":
        return new HumanMessage(msg.content);
      case "assistant":
        return new AIMessage(msg.content);
      case "system":
        return new SystemMessage(msg.content);
      default:
        return new HumanMessage(msg.content);
    }
  });
}

/**
 * Generate a response from the LLM
 * @param messages - Conversation history
 * @param context - Optional RAG context to inject
 */
export async function generateResponse(
  messages: ChatMessage[],
  context?: string,
): Promise<string> {
  const llm = getLLM();

  // Build the full message list with system prompt
  const fullMessages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];

  // Add RAG context if provided
  if (context) {
    fullMessages.push({
      role: "system",
      content: `Poniższy kontekst pochodzi z wcześniejszych rozmów i może być pomocny:\n\n${context}`,
    });
  }

  // Add conversation history
  fullMessages.push(...messages);

  const baseMessages = toBaseMessages(fullMessages);

  try {
    const response = await llm.invoke(baseMessages);
    return typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);
  } catch (error) {
    console.error("LLM Error:", error);
    throw new Error("Nie udało się uzyskać odpowiedzi. Spróbuj ponownie.");
  }
}

/**
 * Stream a response from the LLM
 * @param messages - Conversation history
 * @param context - Optional RAG context to inject
 * @param onChunk - Callback for each chunk
 */
export async function streamResponse(
  messages: ChatMessage[],
  context: string | undefined,
  onChunk: (chunk: string) => void,
): Promise<string> {
  const llm = getLLM();

  const fullMessages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];

  if (context) {
    fullMessages.push({
      role: "system",
      content: `Poniższy kontekst pochodzi z wcześniejszych rozmów i może być pomocny:\n\n${context}`,
    });
  }

  fullMessages.push(...messages);
  const baseMessages = toBaseMessages(fullMessages);

  let fullResponse = "";

  try {
    const stream = await llm.stream(baseMessages);

    for await (const chunk of stream) {
      const content = typeof chunk.content === "string" ? chunk.content : "";
      fullResponse += content;
      onChunk(content);
    }

    return fullResponse;
  } catch (error) {
    console.error("LLM Stream Error:", error);
    throw new Error("Nie udało się uzyskać odpowiedzi. Spróbuj ponownie.");
  }
}
