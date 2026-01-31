# Research: Jednostronicowy landing page + chatbot (Astro, Gemini 3 Flash)

## Decision 1: Framework i typ aplikacji

- **Decision**: Astro.js jako statyczny frontend (SPA-ish) z klientową logiką czatu.
- **Rationale**: Spełnia wymóg statycznej dostawy, jest lekki i dobrze wspiera PWA oraz komponenty UI.
- **Alternatives considered**: Next.js (większy ciężar, SSR niepożądany), plain HTML/JS (trudniej utrzymać większą logikę czatu i PWA).

## Decision 2: Model LLM i integracja

- **Decision**: LangChain JS + Gemini Flash (best‑guess identyfikator: `gemini-3-flash`, fallback do najnowszego „flash” jeśli nazwa się różni).
- **Rationale**: Wymóg użytkownika, szybki model flash, możliwość ustawienia wysokiej jakości odpowiedzi poprzez parametry generacji i precyzyjny system prompt.
- **Alternatives considered**: Bezpośrednie SDK Google bez LangChain (mniej elastyczne w warstwie narzędzi i pamięci), inne modele (niezgodne z wymaganiami).

## Decision 3: „Maksymalna inteligencja” modelu

- **Decision**: Ustawić maksymalne dostępne limity tokenów odpowiedzi i tryb jakości najwyższy, jeśli SDK to wspiera; w przeciwnym razie: niska losowość (np. $T=0.2$), wysoki top‑p (np. 0.95), bez agresywnych skrótów odpowiedzi.
- **Rationale**: W praktyce najwyższa jakość odpowiedzi wynika z niskiej losowości i wysokich limitów wyjściowych.
- **Alternatives considered**: Wysoka losowość (ryzyko niespójności), krótkie limity odpowiedzi (spadek jakości).

## Decision 4: Pamięć rozmowy

- **Decision**: Ostatnie ~800k tokenów przechowywane w IndexedDB jako pamięć „aktywną”. Starsze wiadomości są chunkowane i przenoszone do lokalnej bazy wektorowej (SQLite + vec0) dla kontekstu wyszukiwanego.
- **Rationale**: Spełnia wymaganie długiej pamięci bez backendu i umożliwia odzyskiwanie kontekstu przez RAG.
- **Alternatives considered**: Tylko IndexedDB (ryzyko spadku wydajności), tylko wektor DB (utrata spójnej, krótkoterminowej pamięci rozmowy).

## Decision 5: Embedding i lokalna baza wektorowa

- **Decision**: Transformers.js + model `onnx-community/embeddinggemma-300m-ONNX` cache’owany po pierwszym uruchomieniu; lokalna SQLite w workerze z vec0 i fallbackiem IndexedDB (jak w istniejących plikach `training-embeddings.js`, `vector-db.worker.js`, `vector-search.js`).
- **Rationale**: Wymóg użytkownika, sprawdzony wzorzec offline i wydajnościowy, zgodność z aplikacją statyczną.
- **Alternatives considered**: Zewnętrzna baza wektorowa (wymaga backendu), mniejsze modele (gorsza jakość semantyki).

## Decision 6: PWA

- **Decision**: Włączyć manifest i service worker (np. poprzez Vite PWA plugin w Astro) dla instalowalności.
- **Rationale**: Wymóg możliwości instalacji jako PWA.
- **Alternatives considered**: Brak PWA (niespełnienie wymogu).

## Security/Privacy Note (best‑guess)

- **Decision**: API key z `GEMINI_API_KEY` będzie wstrzykiwany w buildzie do klienta (ryzyko ujawnienia). Akceptowalne w scenariuszu „single user/owner”.
- **Rationale**: Brak backendu zgodnie z konstytucją; brak bezpiecznego sposobu ukrycia klucza w czysto statycznej aplikacji.
- **Alternatives considered**: Własny backend do proxy (narusza „static‑only”).
