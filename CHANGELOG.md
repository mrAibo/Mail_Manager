# Changelog

Alle bemerkenswerten Änderungen an diesem Projekt werden dokumentiert.

## [1.0.0] — 2026-08-03

### Erstveröffentlichung
- Drei-Spalten-Arbeitsbereich: Sidebar-Filter | Absenderliste | Detail-Panel
- Smart-Cleanup-Dashboard mit Aufräumvorschlägen (Newsletter, Speicher, Inaktiv)
- Sammelabmeldung für HTTPS- und mailto-basierte List-Unsubscribe-Header
- Strukturierte Quick-Filter-Sidebar mit ANSICHT/EMPFOHLEN/KRITERIEN/ABMELDUNG
- Undo für Papierkorb, Verschieben, Archiv, Tag und „Als gelesen" mit exakter Wiederherstellung
- Multi-Folder-Undo für Scans über alle Ordner
- Partial-Failure-Behandlung in Move- und Undo-Pfaden
- Vollständige i18n: Deutsch, Englisch, Russisch (506 Keys)
- SVG-Icons, Dark/Light-Theme, Thunderbird 153+
- Kein `messagesDelete` — permanentes Löschen absichtlich nicht unterstützt

## [Unreleased]

### Sicherheit
- Schutzlisten für Absender und Quellordner werden im Background vor Papierkorb-, Ordner- und Tag-Aktionen erneut geprüft
- Jeder MailManager-Tab akzeptiert nur Scan-Ereignisse seines aktiven `scanId`; Undo-Einträge sind tabbezogen
- Nicht erreichbares permanentes Löschen und die Berechtigung `messagesDelete` wurden entfernt
- CSV-Export escaped Anführungszeichen und neutralisiert Tabellenformeln in Absenderfeldern
- Fehlermeldungen werden als Text statt als HTML eingefügt

### Änderungen
- Oberfläche auf **Scannen → Kandidaten prüfen → Aufräumen** reduziert
- Papierkorb-Vorschau wird automatisch berechnet und ist vor der Bestätigung verpflichtend
- Kandidaten-Dashboard und Schnellfilter auf die wichtigsten Optionen gekürzt

### Infrastruktur
- Background-Sicherheitstests und UI-Regeltests ergänzt
- GitHub Actions prüft Unit-Tests, Syntax und XPI-Build mit Node.js 20
- Projekt unter die MIT-Lizenz gestellt

## [0.1.0] — 2026-05-16

### ✨ Features
- Load message headers page-by-page on sender expand (50 messages per page with "Load more")
- Sort messageIds newest-first during scan for better UX
- Keyboard navigation for expanded message rows (↑/↓ between mails, Enter to open)
- Right-click context menus for sender and message rows
- Attachment dialog with open and save functionality
- Inline message text preview (Klartext-Auszug ohne vollständiges Lesen)
- Expand senders into paginated message rows
- Show sender flags (Newsletter, Abmeldbar, Schutz) as compact icons
- Cleanup logic for app initialization with comprehensive test suite
- Individual message selection with checkboxes in expanded sender rows, fully wired into bulk operations (trash, move to folder, tag)
- Keyboard shortcuts dialog with complete list of available shortcuts
- Column visibility configuration with localStorage persistence
- Advanced filter panel: configurable size / last-mail-age / read-status filters, combinable with quick filters
- New "Aktiv <30 Tage" quick filter for recently active senders
- Drag & drop senders or messages onto a folder overlay to move them

### 🐛 Bugfixes
- Prevent duplicate page load from double-clicking "load more" button
- Invalidate message-inspection caches on rescan and single-message operations
- daysSince() returned an epoch-based value instead of null for null dates
- Delete/Entf key did nothing when a selection checkbox held focus — the keyboard handler now lets Delete through for non-text-entry targets
- Message rows had a 5-column grid but 6 elements since the selection checkbox was added — the subject was squeezed to 90px and clipped; grid now has 6 columns
- Move/trash silently did nothing when a single message ID was stale — browser.messages.move is atomic, so one bad ID failed the whole batch and the error was swallowed; the move now retries message-by-message, reports a real error if nothing moved and a notice on partial failure

### ⚡ Performance
- Replace O(n²) sender lookup in the domain view's row builder with a Set
- Memoize domain grouping so it is not recomputed on every filter keystroke
- Debounce the sender filter input (150 ms)

### ♿ Accessibility
- Add role/aria-selected to message rows and domain rows (consistent with sender rows)
- Add table/columnheader container roles to the sender list and header
- Add aria-label to selection checkboxes naming the sender/domain/mail
- Add aria-live to status, progress and selection labels
- Roving tabindex for the sender/message list: arrow keys navigate rows, only one row is a tab stop

### 📚 Documentation
- Permanent install and uninstall instructions for end-users
- Rewrite README to cover current feature set (Zwei-Spalten-Layout, Scan-Profile, etc.)
- Implementation specs for message-loading pagination

### 🔧 Infrastructure
- Add cleanup-logic.mjs and tests to version control
- Ignore Claude Code and build artifacts in .gitignore
- Add npm run build script for automatic .xpi package creation
- Update package.json and skills-lock.json

---

## Format

This changelog follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
