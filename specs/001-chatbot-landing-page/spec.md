# Feature Specification: Jednostronicowy landing page chatbota porad seksuologiczno‑psychologicznych

**Feature Branch**: `001-chatbot-landing-page`
**Created**: 2026-01-31
**Status**: Draft
**Input**: User description: "tworzę aplikacje do porad seksuolog psychologicznych jako chat bot ma być landingapge jednostronicowym, nowoczena czytelna nowoczesna i czytelna"

## User Scenarios & Testing _(mandatory)_

<!--
  IMPORTANT: User stories should be PRIORITIZED as user journeys ordered by importance.
  Each user story/journey must be INDEPENDENTLY TESTABLE - meaning if you implement just ONE of them,
  you should still have a viable MVP (Minimum Viable Product) that delivers value.

  Assign priorities (P1, P2, P3, etc.) to each story, where P1 is the most critical.
  Think of each story as a standalone slice of functionality that can be:
  - Developed independently
  - Tested independently
  - Deployed independently
  - Demonstrated to users independently
-->

### User Story 1 - Zrozumienie oferty i start rozmowy (Priority: P1)

Jako odwiedzający chcę szybko zrozumieć, czym jest chatbot porad seksuologiczno‑psychologicznych i mieć jasny przycisk startu rozmowy, abym mógł od razu rozpocząć kontakt.

**Why this priority**: To główna wartość strony — szybkie zrozumienie usługi i jasna ścieżka działania.

**Independent Test**: Otworzyć stronę i sprawdzić, czy w pierwszym ekranie widać opis i wezwanie do działania prowadzące do rozpoczęcia rozmowy.

**Acceptance Scenarios**:

1. **Given** strona jest otwarta, **When** użytkownik widzi pierwszy ekran, **Then** widzi nazwę usługi, krótki opis wartości i wyraźne wezwanie do działania.
2. **Given** użytkownik klika wezwanie do działania, **When** następuje przekierowanie, **Then** użytkownik trafia do miejsca rozpoczęcia rozmowy z chatbotem.

---

### User Story 2 - Zrozumienie, jak to działa (Priority: P2)

Jako odwiedzający chcę poznać w prosty sposób, jak działa chatbot i w jakich sytuacjach może pomóc, abym mógł ocenić, czy to dla mnie.

**Why this priority**: Buduje zaufanie i pomaga podjąć decyzję o rozpoczęciu rozmowy.

**Independent Test**: Przewinąć stronę i potwierdzić obecność zwięzłej sekcji „jak to działa” oraz opisu obszarów wsparcia.

**Acceptance Scenarios**:

1. **Given** użytkownik przewija stronę, **When** dociera do sekcji informacyjnych, **Then** widzi jasny opis działania i przykładowe obszary wsparcia.
2. **Given** użytkownik przegląda stronę na telefonie, **When** przewija treści, **Then** układ pozostaje czytelny i nie wymaga poziomego przewijania.

---

### User Story 3 - Poczucie bezpieczeństwa i granice wsparcia (Priority: P3)

Jako odwiedzający chcę wiedzieć, jakie są granice wsparcia oraz że usługa nie zastępuje pomocy w nagłych sytuacjach, abym mógł bezpiecznie z niej korzystać.

**Why this priority**: Treści dotyczą wrażliwej tematyki i wymagają jasnych zasad bezpieczeństwa.

**Independent Test**: Sprawdzić, czy na stronie znajduje się krótka informacja o bezpieczeństwie i ograniczeniach.

**Acceptance Scenarios**:

1. **Given** użytkownik szuka informacji o bezpieczeństwie, **When** odnajduje sekcję z zasadami, **Then** widzi jasną informację o ograniczeniach i rekomendacji kontaktu z pomocą w sytuacjach nagłych.
2. **Given** użytkownik przewija stronę do końca, **When** dociera do stopki, **Then** znajduje podstawowe informacje identyfikujące usługę lub kontakt.

---

[Add more user stories as needed, each with an assigned priority]

### Edge Cases

- Co, jeśli użytkownik ma wyłączoną obsługę skryptów i przegląda tylko treści statyczne?
- Co, jeśli ekran jest bardzo mały (telefon) i elementy konkurują o miejsce?
- Co, jeśli link do rozpoczęcia rozmowy jest chwilowo niedostępny?

## Requirements _(mandatory)_

<!--
  ACTION REQUIRED: The content in this section represents placeholders.
  Fill them out with the right functional requirements.
-->

### Functional Requirements

- **FR-001**: Strona MUSI być jednostronicowym landing page z jasnym nagłówkiem i krótką propozycją wartości.
- **FR-002**: Strona MUSI zawierać widoczne wezwanie do działania prowadzące do rozpoczęcia rozmowy z chatbotem.
- **FR-003**: Strona MUSI zawierać zwięzłą sekcję „jak to działa” oraz przykładowe obszary wsparcia.
- **FR-004**: Strona MUSI zawierać informacje o bezpieczeństwie i ograniczeniach, w tym wskazanie, że nie jest to pomoc w nagłych sytuacjach.
- **FR-005**: Strona MUSI mieć czytelną hierarchię treści (nagłówek, sekcje, krótkie akapity) oraz spójną, minimalistyczną estetykę wspierającą przejrzystość.
- **FR-006**: Strona MUSI być responsywna i użyteczna na telefonach, tabletach i komputerach.
- **FR-007**: Użytkownik MUSI móc odnaleźć podstawowe informacje kontaktowe lub identyfikujące usługę w stopce.
- **FR-008**: System MUSI zakładać pojedynczego użytkownika zarządzającego treściami i działaniem strony (bez ról i uprawnień wieloużytkownikowych).

### Out of Scope

- Rzeczywista obsługa rozmów lub logika chatbota.
- Konta użytkowników, płatności, zapisy i przechowywanie danych użytkowników.
- Wielu użytkowników, role i uprawnienia.

### Assumptions

- Dostawca usługi udostępni docelowy link do rozpoczęcia rozmowy.
- Kluczowe treści (nazwa, opis, zastrzeżenia prawne) zostaną dostarczone przez właściciela produktu.
- Strona będzie używana i zarządzana przez jedną osobę.

### Dependencies

- Dostarczenie finalnych treści i linku do rozmowy przez właściciela produktu.

## Success Criteria _(mandatory)_

<!--
  ACTION REQUIRED: Define measurable success criteria.
  These must be technology-agnostic and measurable.
-->

### Measurable Outcomes

- **SC-001**: Co najmniej 90% badanych użytkowników potrafi wskazać główną wartość usługi i przycisk startu rozmowy w ciągu 10 sekund.
- **SC-002**: Co najmniej 90% badanych użytkowników poprawnie opisuje, jak działa usługa, po jednokrotnym przejrzeniu strony.
- **SC-003**: Średnia ocena „czytelności i nowoczesności” strony wynosi co najmniej 4/5 w krótkiej ankiecie.
- **SC-004**: Strona jest poprawnie wyświetlana i w pełni czytelna w aktualnych wersjach Chrome, Firefox i Safari oraz na urządzeniach mobilnych.


chcę korzystac z lang chain model Gemini 3 Flash mienną środowiskową, np. GEMINI_API_KEY przechowuje api key ma być ustawiony pod maksymalną mozliwą inteligencje i ustawiony pod asystenta sexuologa psychologa
