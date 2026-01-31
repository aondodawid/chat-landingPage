# Tasks: Jednostronicowy landing page + chatbot (Astro, Gemini Flash)

**Input**: Design documents from `/specs/001-chatbot-landing-page/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Not requested in spec (no test tasks included)

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure

- [x] T001 Initialize Astro project scaffold and base folders in package.json, astro.config.mjs, src/pages/index.astro, src/components/, src/services/, src/workers/, public/
- [x] T002 Add required dependencies and scripts in package.json (Astro, LangChain JS + Gemini adapter, Transformers.js, PWA plugin)
- [x] T003 [P] Add base global styles and tokens in src/styles/global.css

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

- [x] T004 Configure PWA support in astro.config.mjs and add manifest in public/manifest.webmanifest
- [x] T005 [P] Add PWA icons and meta assets in public/icons/
- [x] T006 Implement Gemini Flash LLM client with env key in src/services/llm-client.ts
- [x] T007 [P] Define psycholog‑seksuolog system prompt and safety guidance in src/lib/prompts.ts
- [x] T008 [P] Implement token estimation utilities in src/lib/token-utils.ts
- [x] T009 Implement IndexedDB memory store (active window up to 800k tokens) in src/services/memory-store.ts
- [x] T010 Implement embedding pipeline + cache with Transformers.js in src/services/embeddings.ts
- [x] T011 Implement vector DB worker (SQLite + vec0 + IDB fallback) in src/workers/vector-db.worker.js
- [x] T012 Implement archive/search bridge (move old messages to vector DB, retrieve context) in src/services/vector-store.ts
- [x] T013 Implement chat session orchestrator (LLM + memory + context retrieval) in src/services/chat-session.ts

**Checkpoint**: Foundation ready — user story implementation can now begin

---

## Phase 3: User Story 1 - Zrozumienie oferty i start rozmowy (Priority: P1) 🎯 MVP

**Goal**: Jasny przekaz wartości i szybki start rozmowy z chatbotem.

**Independent Test**: Otworzyć stronę i sprawdzić widoczność hero + CTA; kliknięcie CTA uruchamia czat lub przewija do sekcji czatu.

### Implementation for User Story 1

- [x] T014 [US1] Zbudować sekcję hero z nazwą usługi, opisem i CTA w src/pages/index.astro
- [x] T015 [US1] Dodać sekcję czatu i kontener UI w src/pages/index.astro
- [x] T016 [P] [US1] Utworzyć komponent czatu (UI: lista wiadomości, input, przycisk) w src/components/ChatWidget.astro
- [x] T017 [US1] Podłączyć logikę czatu do LLM + pamięci w src/components/chat-widget.ts
- [x] T018 [US1] Skonfigurować zachowanie CTA (scroll/open chat + fallback link) w src/pages/index.astro

**Checkpoint**: User Story 1 działa niezależnie i umożliwia start rozmowy

---

## Phase 4: User Story 2 - Zrozumienie, jak to działa (Priority: P2)

**Goal**: Wyjaśnić działanie i obszary wsparcia.

**Independent Test**: Przewinąć stronę i potwierdzić obecność sekcji „jak to działa” i „obszary wsparcia”.

### Implementation for User Story 2

- [x] T019 [US2] Dodać sekcję „Jak to działa" w src/pages/index.astro
- [x] T020 [US2] Dodać sekcję „Obszary wsparcia" z listą przykładów w src/pages/index.astro

**Checkpoint**: User Story 2 działa niezależnie i informuje użytkownika

---

## Phase 5: User Story 3 - Poczucie bezpieczeństwa i granice wsparcia (Priority: P3)

**Goal**: Przekazać ograniczenia i zasady bezpieczeństwa.

**Independent Test**: Użytkownik znajduje sekcję bezpieczeństwa i stopkę z informacjami.

### Implementation for User Story 3

- [x] T021 [US3] Dodać sekcję bezpieczeństwa i ograniczeń w src/pages/index.astro
- [x] T022 [US3] Dodać stopkę z informacjami identyfikującymi/kontaktowymi w src/pages/index.astro

**Checkpoint**: User Story 3 działa niezależnie i zwiększa bezpieczeństwo

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [x] T023 [P] Ujednolicić typografię, spacing i responsywność w src/styles/global.css
- [x] T024 Poprawić dostępność (nagłówki, aria, kontrast) w src/pages/index.astro oraz src/components/ChatWidget.astro
- [x] T025 Zoptymalizować wydajność (lazy‑load, minimalny JS) w astro.config.mjs i src/pages/index.astro
- [x] T026 Zweryfikować instrukcje uruchomienia i PWA w specs/001-chatbot-landing-page/quickstart.md

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories
- **User Stories (Phase 3+)**: Depend on Foundational completion
- **Polish (Phase 6)**: Depends on completing desired user stories

### User Story Dependencies

- **US1 (P1)**: Depends on Foundational (Phase 2)
- **US2 (P2)**: Depends on Foundational (Phase 2)
- **US3 (P3)**: Depends on Foundational (Phase 2)

### Parallel Opportunities

- Phase 1: T003 can run in parallel
- Phase 2: T005, T007, T008 can run in parallel
- Phase 3: T016 can run in parallel with T014/T015
- Phase 6: T023 can run in parallel with other polish tasks

---

## Parallel Example: User Story 1

- Task: "T014 [US1] Zbudować sekcję hero..." in src/pages/index.astro
- Task: "T016 [P] [US1] Utworzyć komponent czatu..." in src/components/ChatWidget.astro

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational
3. Complete Phase 3: User Story 1
4. Validate User Story 1 independently

### Incremental Delivery

1. Setup + Foundational
2. US1 → validate
3. US2 → validate
4. US3 → validate
5. Polish
