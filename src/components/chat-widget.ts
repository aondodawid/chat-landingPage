/**
 * Chat Widget Logic
 * Handles user input, message display, and LLM interaction
 */

import type { ConversationMessage } from "../services/memory-store";

// DOM Elements
let messagesContainer: HTMLElement;
let inputForm: HTMLFormElement;
let inputField: HTMLTextAreaElement;
let sendButton: HTMLButtonElement;
let loadingIndicator: HTMLElement;
let statsContainer: HTMLElement;

type ChatSessionType = import("../services/chat-session").ChatSession;

// Chat session instance (lazy-loaded)
let chatSession: ChatSessionType | null = null;
let historyLoaded = false;

// State
let isProcessing = false;
let showStats = false; // Toggle for dev mode

/**
 * Initialize the chat widget
 */
export async function initChatWidget(): Promise<void> {
  // Get DOM elements
  messagesContainer = document.getElementById("chat-messages")!;
  inputForm = document.getElementById("chat-form") as HTMLFormElement;
  inputField = document.getElementById("chat-input") as HTMLTextAreaElement;
  sendButton = document.getElementById("chat-send-btn") as HTMLButtonElement;
  loadingIndicator = document.getElementById("chat-loading")!;
  statsContainer = document.getElementById("chat-stats")!;

  if (!messagesContainer || !inputForm || !inputField || !sendButton) {
    console.error("Chat widget elements not found");
    return;
  }

  // Set up event listeners
  inputForm.addEventListener("submit", handleSubmit);
  inputField.addEventListener("input", handleInputChange);
  inputField.addEventListener("keydown", handleKeyDown);

  // Auto-resize textarea
  inputField.addEventListener("input", autoResizeTextarea);

  // History and session are loaded lazily on first user interaction

  // Enable dev stats with Ctrl+Shift+D
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === "D") {
      toggleStats();
    }
  });
}

/**
 * Load conversation history from memory
 */
async function loadHistory(): Promise<void> {
  try {
    const session = await getSession();
    const history = await session.getHistory();
    if (history.length > 0) {
      messagesContainer.innerHTML = "";

      // Add historical messages
      for (const msg of history) {
        if (msg.role === "user" || msg.role === "assistant") {
          appendMessage(msg.role, msg.content, false);
        }
      }

      scrollToBottom();
    }
    historyLoaded = true;
  } catch (e) {
    console.warn("Failed to load history:", e);
  }
}

/**
 * Handle form submission
 */
async function handleSubmit(e: Event): Promise<void> {
  e.preventDefault();

  const content = inputField.value.trim();
  if (!content || isProcessing) return;

  // Load history lazily on first submit
  if (!historyLoaded) {
    await loadHistory();
  }

  // Clear input
  inputField.value = "";
  resetTextareaHeight();
  updateSendButtonState();

  // Send message
  await sendMessage(content);
}

/**
 * Handle input changes for send button state
 */
function handleInputChange(): void {
  updateSendButtonState();
}

/**
 * Handle keyboard shortcuts
 */
function handleKeyDown(e: KeyboardEvent): void {
  // Submit on Enter (without Shift)
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    inputForm.dispatchEvent(new Event("submit"));
  }
}

/**
 * Auto-resize textarea based on content
 */
function autoResizeTextarea(): void {
  inputField.style.height = "auto";
  inputField.style.height = Math.min(inputField.scrollHeight, 120) + "px";
}

/**
 * Reset textarea height
 */
function resetTextareaHeight(): void {
  inputField.style.height = "auto";
}

/**
 * Update send button enabled state
 */
function updateSendButtonState(): void {
  const hasContent = inputField.value.trim().length > 0;
  sendButton.disabled = !hasContent || isProcessing;
}

/**
 * Send a message and get response
 */
async function sendMessage(content: string): Promise<void> {
  isProcessing = true;
  updateSendButtonState();
  showLoading(true);

  // Add user message to UI immediately
  appendMessage("user", content);

  try {
    // Create a placeholder for streaming response
    const responseEl = appendMessage("assistant", "", true);
    let currentContent = "";

    // Stream the response
    const session = await getSession();
    await session.sendMessage(content, (partial) => {
      currentContent = partial;
      responseEl.textContent = partial;
      scrollToBottom();
    });

    // Ensure final content is displayed
    if (responseEl.textContent !== currentContent) {
      responseEl.textContent = currentContent;
    }
  } catch (error) {
    console.error("Failed to send message:", error);
    appendMessage(
      "assistant",
      "Przepraszam, wystąpił błąd. Spróbuj ponownie za chwilę.",
    );
  } finally {
    isProcessing = false;
    showLoading(false);
    updateSendButtonState();
    scrollToBottom();
    updateStats();
  }
}

/**
 * Append a message to the messages container
 */
function appendMessage(
  role: "user" | "assistant",
  content: string,
  isStreaming = false,
): HTMLElement {
  const messageEl = document.createElement("div");
  messageEl.className = `message message-${role}`;
  messageEl.textContent = content;

  if (isStreaming) {
    messageEl.setAttribute("aria-busy", "true");
  }

  messagesContainer.appendChild(messageEl);
  scrollToBottom();

  return messageEl;
}

/**
 * Scroll messages container to bottom
 */
function scrollToBottom(): void {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

/**
 * Show/hide loading indicator
 */
function showLoading(show: boolean): void {
  loadingIndicator.classList.toggle("visible", show);
  loadingIndicator.setAttribute("aria-hidden", (!show).toString());
}

/**
 * Callback when a message is added to memory
 */
function handleMessageAdded(message: ConversationMessage): void {
  // Messages are already added to UI during send flow
  // This callback could be used for syncing or other purposes
  console.debug("Message added:", message.id);
}

/**
 * Callback when messages are evicted from active memory
 */
function handleMessagesEvicted(messages: ConversationMessage[]): void {
  console.debug(`${messages.length} messages archived to vector DB`);
}

/**
 * Toggle stats display
 */
function toggleStats(): void {
  showStats = !showStats;
  statsContainer.classList.toggle("visible", showStats);
  if (showStats) {
    updateStats();
  }
}

/**
 * Update stats display
 */
async function updateStats(): Promise<void> {
  if (!showStats) return;

  try {
    const session = await getSession();
    const stats = await session.getStats();
    statsContainer.textContent = `Pamięć: ${stats.messageCount} wiadomości | ${(stats.tokenTotal / 1000).toFixed(1)}k tokenów (${stats.percentUsed.toFixed(1)}%)`;
  } catch (e) {
    statsContainer.textContent = "Błąd ładowania statystyk";
  }
}

async function getSession(): Promise<ChatSessionType> {
  if (chatSession) return chatSession;

  const mod = await import("../services/chat-session");
  chatSession = new mod.ChatSession({
    onMessageAdded: handleMessageAdded,
    onEvicted: handleMessagesEvicted,
  });

  return chatSession;
}
