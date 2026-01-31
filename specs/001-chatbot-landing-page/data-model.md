# Data Model: Jednostronicowy landing page + chatbot

## Entities

### 1) `ConversationMessage`

- **Purpose**: Pojedyncza wiadomość w aktywnej pamięci rozmowy.
- **Fields**:
  - `id` (string, uuid)
  - `role` (enum: `user` | `assistant` | `system`)
  - `content` (string)
  - `createdAt` (ISO datetime)
  - `tokenCount` (number, estimated)
  - `sessionId` (string)

### 2) `ActiveMemoryWindow`

- **Purpose**: Zbiór ostatnich wiadomości przechowywanych w IndexedDB (do ~800k tokenów).
- **Fields**:
  - `id` (string)
  - `messages` (array of `ConversationMessage` references)
  - `tokenTotal` (number)
  - `updatedAt` (ISO datetime)

### 3) `ArchivedChunk`

- **Purpose**: Starsze fragmenty rozmowy przeniesione do bazy wektorowej.
- **Fields**:
  - `id` (number | string)
  - `chunkIndex` (number)
  - `text` (string)
  - `source` (string: `conversation`)
  - `createdAt` (ISO datetime)
  - `embedding` (float[768] as binary/blob in SQLite)

### 4) `VectorIndexMeta`

- **Purpose**: Metadane lokalnej bazy wektorowej.
- **Fields**:
  - `userId` (string)
  - `sourceName` (string)
  - `chunkCount` (number)
  - `updatedAt` (ISO datetime)
  - `modelId` (string)

### 5) `AssistantConfig`

- **Purpose**: Konfiguracja modelu i zachowania asystenta.
- **Fields**:
  - `modelId` (string)
  - `temperature` (number)
  - `topP` (number)
  - `maxOutputTokens` (number)
  - `systemPrompt` (string)

## Relationships

- `ActiveMemoryWindow` agreguje wiele `ConversationMessage`.
- `ArchivedChunk` powstaje z grupy starszych `ConversationMessage`.
- `VectorIndexMeta` opisuje kolekcję `ArchivedChunk`.

## Validation Rules

- `tokenTotal` w `ActiveMemoryWindow` nie przekracza 800k tokenów (nadmiar trafia do `ArchivedChunk`).
- `content` nie może być pusty.
- `embedding` zawsze ma długość 768 (float32).

## State Transitions (simplified)

1. `ConversationMessage` (active) → przekroczenie limitu → chunkowanie → `ArchivedChunk`.
2. `ArchivedChunk` → indeksacja → dostępne w wyszukiwaniu kontekstu.
