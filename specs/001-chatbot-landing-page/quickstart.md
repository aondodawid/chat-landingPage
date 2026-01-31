# Quickstart: Jednostronicowy landing page + chatbot (Astro)

## Wymagania

- Node.js 20 LTS
- Przeglądarka Chrome/Firefox/Safari (najnowsze wersje)
- Klucz API do Google Gemini

## Konfiguracja

1. Skopiuj `.env.example` do `.env` (jeśli istnieje) lub utwórz plik `.env`:
   ```bash
   echo "PUBLIC_GEMINI_API_KEY=twój-klucz-api" > .env
   ```

2. Upewnij się, że zmienna `PUBLIC_GEMINI_API_KEY` jest ustawiona prawidłowo.

## Uruchomienie (dev)

```bash
# 1. Zainstaluj zależności
npm install

# 2. Uruchom serwer deweloperski
npm run dev

# 3. Otwórz w przeglądarce: http://localhost:4321
```

## Build produkcyjny

```bash
# Zbuduj aplikację
npm run build

# Podgląd lokalny buildu
npm run preview
```

Statyczne pliki zostaną wygenerowane w katalogu `dist/`.

## Instalacja jako PWA

1. Otwórz aplikację w przeglądarce (Chrome/Edge zalecane)
2. Kliknij ikonę instalacji w pasku adresu (lub menu ⋮ → "Zainstaluj aplikację")
3. Aplikacja będzie dostępna jako samodzielna aplikacja desktopowa/mobilna

## Funkcje

- **Czat z AI**: Rozmowy z asystentem psycholog-seksuolog (Gemini Flash)
- **Pamięć rozmowy**: Do 800k tokenów przechowywanych lokalnie (IndexedDB)
- **Archiwum wektorowe**: Starsze wiadomości archiwizowane z wyszukiwaniem semantycznym
- **Offline-first**: Modele ML cache'owane lokalnie, PWA działa bez połączenia
- **Prywatność**: Wszystkie dane pozostają na urządzeniu użytkownika

## Rozwiązywanie problemów

### Błąd API Gemini
- Sprawdź czy `PUBLIC_GEMINI_API_KEY` jest poprawny
- Upewnij się, że masz aktywne konto Google Cloud z włączonym Gemini API

### Wolne ładowanie modelu embeddingów
- Pierwsze uruchomienie może trwać dłużej (pobieranie ~300MB modelu ONNX)
- Model jest cache'owany lokalnie na kolejne użycia

### PWA nie instaluje się
- Upewnij się, że używasz HTTPS lub localhost
- Sprawdź czy manifest.webmanifest jest poprawnie serwowany

## Struktura projektu

```
src/
├── components/
│   ├── ChatWidget.astro    # UI komponentu czatu
│   └── chat-widget.ts      # Logika czatu
├── services/
│   ├── llm-client.ts       # Klient Gemini Flash
│   ├── memory-store.ts     # IndexedDB dla pamięci rozmowy
│   ├── embeddings.ts       # Pipeline embeddingów (Transformers.js)
│   ├── vector-store.ts     # Most do bazy wektorowej
│   └── chat-session.ts     # Orkiestrator sesji czatu
├── workers/
│   └── vector-db.worker.js # Web Worker dla SQLite + vec0
├── lib/
│   ├── prompts.ts          # System prompty i wiadomości
│   └── token-utils.ts      # Narzędzia do tokenów
├── styles/
│   └── global.css          # Globalne style i tokeny
└── pages/
    └── index.astro         # Główna strona landing page
```

## Uwagi bezpieczeństwa

- Klucz API jest widoczny po stronie klienta (akceptowalne dla single-user)
- Dla wersji publicznej rozważ proxy backendowe dla API
- Wszystkie rozmowy przechowywane lokalnie, nie są wysyłane na serwer
