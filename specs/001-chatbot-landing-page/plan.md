# Implementation Plan: Jednostronicowy landing page + chatbot (Astro, Gemini Flash)

**Branch**: `001-chatbot-landing-page` | **Date**: 2026-01-31 | **Spec**: [specs/001-chatbot-landing-page/spec.md](specs/001-chatbot-landing-page/spec.md)
**Input**: Feature specification from `/specs/001-chatbot-landing-page/spec.md`

## Summary

Zbudować nowoczesny, jednostronicowy landing page w Astro.js z osadzoną funkcją czatu. Czat używa LangChain JS i modelu Gemini Flash z maksymalną jakością odpowiedzi dla asystenta psychologa‑seksuologa. Pamięć rozmowy: do ~800k tokenów w IndexedDB, starsze treści chunkowane do lokalnej bazy wektorowej (SQLite + vec0) z embeddingami z `onnx-community/embeddinggemma-300m-ONNX` w Transformers.js. Aplikacja instalowalna jako PWA.

## Technical Context

**Language/Version**: TypeScript/JavaScript (Astro, Node.js 20 LTS)
**Primary Dependencies**: Astro, LangChain JS, (LangChain Google/Gemini adapter), Transformers.js, sqlite/vec0 (browser worker), PWA plugin
**Storage**: IndexedDB (aktywny kontekst), SQLite (OPFS/IDB fallback) dla wektorów, CacheStorage (model/asset cache)
**Testing**: Manualna weryfikacja w przeglądarce (Chrome/Firefox/Safari)
**Target Platform**: Nowoczesne przeglądarki desktop/mobile, PWA
**Project Type**: Web (statyczny frontend)
**Performance Goals**: Płynność UI 60 fps, szybki start (FCP < 2s na desktop), wydajne wyszukiwanie kontekstu lokalnie
**Constraints**: Brak backendu; klucz API po stronie klienta; pamięć rozmowy do ~800k tokenów w IndexedDB
**Scale/Scope**: Single‑user, jedna aplikacja, jedna strona

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

- **I. Static-Only Delivery**: PASS — całość jako statyczny frontend, brak backendu.
- **II. Minimal Dependencies**: PASS — zależności ograniczone do wymaganych przez LLM, embedding i PWA.
- **III. Accessibility Basics**: PASS — plan uwzględnia semantyczny HTML i czytelność.
- **IV. Performance Basics**: PASS — cache modelu, lokalne embeddingi, minimalizacja skryptów.
- **V. Simplicity**: PASS — prosta struktura i pojedynczy przepływ.

## Project Structure

### Documentation (this feature)

```text
specs/001-chatbot-landing-page/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
public/
├── manifest.webmanifest
├── icons/
└── sqlite-vec/          # sqlite3.mjs/wasm and vec0 assets

src/
├── pages/
│   └── index.astro
├── components/
├── layouts/
├── styles/
├── services/
│   ├── llm-client.ts
│   ├── embeddings.ts
│   └── memory-store.ts
├── workers/
│   └── vector-db.worker.js
└── lib/
    ├── prompts.ts
    └── token-utils.ts
```

**Structure Decision**: Statyczna aplikacja Astro z logiką LLM i pamięci po stronie klienta. Brak backendu.

## Post-Design Constitution Check

- **I. Static-Only Delivery**: PASS
- **II. Minimal Dependencies**: PASS (zależności uzasadnione wymaganiami LLM/embedding/PWA)
- **III. Accessibility Basics**: PASS (zdefiniowane w wymaganiach UI)
- **IV. Performance Basics**: PASS (cache i lokalne przetwarzanie)
- **V. Simplicity**: PASS (single‑page + proste moduły)

## Complexity Tracking

No constitution violations.
