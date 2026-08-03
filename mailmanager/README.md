# MailManager

MailManager ist ein Thunderbird-Add-on zur **lokalen Analyse und Aufräumung
großer Postfächer**. Es gruppiert E-Mails nach Absender (und Domain), bewertet
jeden Absender mit einem **Aufräum-Score**, lässt einzelne Mails direkt in der
Liste untersuchen und bietet Bulk-Aktionen mit Vorschau, Regeln, Schutzlisten
und Protokoll.

**100 % lokal** — kein Server, keine Cloud, kein Tracking, keine Telemetrie.
Kein Zugriff auf Adressbücher, Kalender oder das Netz.

---

## Hauptziel

Große Mailboxen schnell und **sicher** aufräumen:

- unnötige Newsletter und Bulk-Absender finden
- Speicherfresser erkennen
- alte Mails kontrolliert in den Papierkorb verschieben
- wichtige/letzte Mails gezielt behalten
- persönliche Absender vor Fehlbedienung schützen
- jede Aktion nachvollziehbar protokollieren

---

## Oberfläche

MailManager öffnet sich als eigener Tab in einem **Zwei-Spalten-Layout** mit
hellem Thema:

- **Seitenleiste links** (einklappbar über «) — bündelt die gesamte Steuerung:
  - **1 · Quelle scannen** — Konto, Ordner, Scan-Profil, ▶ Scannen
  - **Ansicht** — Umschalter Absender / Domains
  - **2 · Kandidaten prüfen** — die wichtigsten Schnellfilter
  - **Fuß** — das Menü **⚙ Werkzeuge**
- **Hauptbereich rechts** — drei kompakte Kandidatenkarten, Filter-/Sortierleiste,
  E-Mail-Liste und unten **3 · Aufräumen** mit den Aktionen für die Auswahl

Der Zustand der Seitenleiste wird lokal gemerkt.

---

## Funktionen

### Scannen & Scan-Profile

Ein Scan liest die Kopfdaten der Mails eines Ordners. Über das **Scan-Profil**
lässt sich der Umfang vorab eingrenzen:

- **Vollscan** — alle Mails
- **Nur alte Mails > 1 Jahr**
- **Nur Newsletter/Bulk**
- **Nur ungelesene**
- **Aufräum-Kandidaten**

Systemordner (Gesendet, Entwürfe, Archiv, Papierkorb, Spam, Postausgang) werden
vom Scan ausgeschlossen. Geschützte Absender und Quellordner werden vor
Papierkorb-, Ordner- und Tag-Aktionen erneut im Background geprüft. Mehrere
Konten sind einzeln auswählbar.

### Analyse & Aufräum-Score

Pro Absender werden ermittelt: Anzahl Mails, Gesamtgröße, gelesen/ungelesen-Quote,
älteste und neueste Mail sowie Beispiel-Betreffe.

Der **Aufräum-Score** (0–100) ist **kein Sicherheitsrisiko-Score**. Er beantwortet:

> Wie stark lohnt es sich vermutlich, diesen Absender aufzuräumen?

Er basiert auf **Mail-Volumen**, **Ungelesen-Rate** und **Inaktivität**. Ein hoher
Wert heißt: viele (oft ungelesene) Mails, lange keine Aktivität — ein guter
Kandidat zum Löschen, Archivieren, Sortieren oder Abmelden.

### Ansichten

- **Absender** — Standardansicht, eine Zeile je Absender
- **Domains** — fasst mehrere Absender derselben Domain zusammen, um Anbieter
  gesammelt aufzuräumen

### Schnellfilter & Aufräum-Dashboard

Schnellfilter grenzen die Liste mit einem Klick ein (z. B. Hoher Score,
> 100 Mails, > 100 MB, Inaktiv > 1 Jahr, Ungelesen > 50 %, Newsletter/Bulk,
Abmeldbar, Schutz-Vorschläge, Ausgewählt).

Das **Aufräum-Dashboard** in der Seitenleiste zeigt automatisch die lohnendsten
Kandidaten und erlaubt, passende Absender direkt auszuwählen.

### Sortierung

Sortieren nach Aufräum-Score, Anzahl, Größe, Älteste, Aktivität oder A–Z —
wahlweise über das **Sortier-Dropdown** oder per **Klick auf den Spaltenkopf**
(erneuter Klick kehrt die Richtung um, ein ▲/▼ zeigt die aktive Spalte).

### Mails untersuchen

Jeder Absender mit mehr als einer Mail lässt sich **aufklappen** (Klick auf das
▸-Symbol). Darunter erscheinen die einzelnen Mails — neueste zuerst,
**seitenweise** geladen (50 pro Seite, „Weitere laden" für den Rest).

Je Mail-Zeile: gelesen/ungelesen, Betreff, Datum, Größe und ein 📎 bei Anhängen.

- **Inline-Vorschau** — Klick auf eine Mail-Zeile zeigt darunter die ersten
  ~5–10 Zeilen Klartext, ohne die Mail voll in Thunderbird zu öffnen
- **Anhänge** — über das 📎-Symbol öffnet sich ein Fenster mit allen Anhängen
  (Name, Größe); jeder lässt sich **öffnen** oder **speichern**, dazu
  „Alle speichern"
- **Vollständig öffnen / Antworten** — über das Rechtsklick-Menü

### Markierungen

Statt überladener Text-Badges zeigt MailManager kompakte Icons neben dem
Absendernamen (mit Tooltip): 📨 Newsletter/Bulk, 🚫 Abmeldung möglich,
🛡️ Schutz vorgeschlagen.

### Rechtsklick-Menüs

- **Auf einem Absender:** Neueste Mail öffnen · Mails auf-/zuklappen · Zur
  Auswahl hinzufügen · Alle Mails in Papierkorb · In Ordner · Tag · Abmelden ·
  Aufräum-Regel anwenden · Absender schützen · Adresse kopieren
- **Auf einer einzelnen Mail:** In Thunderbird öffnen · Antworten · Vorschau
  ein-/ausklappen · Anhänge … · Diese Mail in den Papierkorb · Betreff kopieren

### Aktionen

Bulk-Aktionen pro Absender, Domain oder Auswahl: in den **Papierkorb** oder einen
**Ordner** verschieben (neu anlegen oder bestehend), **Tag** setzen,
**Abmelden**, **Export** als CSV oder JSON. Die Oberfläche bietet keine Aktion
zum permanenten Löschen.
Jede Absender-Zeile hat zusätzlich Direkt-Symbole: ↗ öffnen, 🛡 schützen,
🗑 Papierkorb.

Nach Papierkorb-Aktionen ist ein kurzfristiges **Rückgängig** möglich, sofern
Thunderbird neue Message-IDs nach dem Verschieben zurückmeldet.

### Sichere Papierkorb-Regeln & Vorschau

Im Papierkorb-Dialog lassen sich Regeln setzen:

- nur Mails **älter als X Tage** verschieben
- pro Absender die **neuesten N Mails behalten**

Schnellregeln (Presets): Keine Regeln · Älter als 90 Tage · Älter als 1 Jahr ·
1 Jahr + letzte 5 behalten. Die zuletzt genutzten Werte werden lokal gespeichert.

Die **Vorschau** berechnet vorab, wie viele Mails verschoben würden, wie viele
durch Regeln erhalten bleiben und welche Größe betroffen ist — ohne etwas
auszuführen.

### Gespeicherte Aufräum-Regeln

Regeln können pro Absender, Domain oder Auswahl gespeichert werden (z. B.
`amazon.de → älter als 365 Tage + letzte 5 behalten`). Die Regelverwaltung
erlaubt Anzeigen, Anwenden, Löschen, Import und Export.

### Schutzliste

Geschützte Absender sind vor versehentlichen Aktionen geschützt. Funktionen:
einzelne Absender schützen/entsperren, Schutz-Vorschläge anzeigen, Schutzliste
filtern, leeren, importieren/exportieren. Schutz wird z. B. bei persönlichen
Absendern, sehr neuen Mails, kleinen Absendergruppen und hoher Lese-Quote
vorgeschlagen.

### Sicherheitswarnungen

Vor Papierkorb-Aktionen warnt MailManager bei riskanter Auswahl (sehr neue
Mails, persönliche Absender, sehr kleine Gruppen, überwiegend gelesene Mails,
sehr viele betroffene Mails, stark gemischte Domain-Auswahl). Bei hohen
Warnungen muss zusätzlich bestätigt werden, dass die Hinweise geprüft wurden.

### Abmelden

Der Abmelde-Check liest den `List-Unsubscribe`-Header gezielt geprüfter
Absender:

- **mailto:** → öffnet das Thunderbird-Verfassen-Fenster
- **https:** → öffnet nach Bestätigung den Standardbrowser

Die genaue Abmelde-Prüfung erfolgt erst bei Bedarf, damit der normale Scan
schnell bleibt.

### Aktionsprotokoll

Lokal wird ein Protokoll geführt: Zeitpunkt, Aktionstyp, Konto/Ordner, betroffene
Absender, ausgewählte/betroffene/übersprungene Mails, verwendete Regeln,
Undo-Information. Das Protokoll lässt sich anzeigen, leeren und als JSON
exportieren.

### Diagnose

Das Diagnose-Panel zeigt technische Zähler zur Fehlersuche (Versionen, Konto,
Ordner, Ansicht, Filter, Auswahl, Cache-Status, Anzahl Regeln/geschützter
Absender, Ordnerliste). Es zeigt **keine Mail-Inhalte**.

### Cache

Das Scan-Ergebnis wird für die laufende Thunderbird-Sitzung in
`browser.storage.session` zwischengespeichert. Beim erneuten Öffnen des Tabs in
derselben Sitzung erscheint die letzte Analyse; nach einem Thunderbird-Neustart
ist ein neuer Scan nötig. Es gibt **keine eigene Datenbank** — Thunderbird selbst
ist der Nachrichten-Index.

---

## Tastatur & Maus

| Eingabe | Wirkung |
|---|---|
| Klick auf Zeile | Absender markieren / abwählen |
| Shift + Klick | Bereich markieren |
| Checkbox | einzelne Zeile markieren |
| Klick auf ▸ | Absender auf-/zuklappen |
| Klick auf Mail-Zeile | Inline-Vorschau auf-/zuklappen |
| Klick auf Spaltenkopf | nach dieser Spalte sortieren |
| Rechtsklick | Kontextmenü (Absender bzw. Mail) |
| Entf | ausgewählte Absender in den Papierkorb |
| Enter | neueste Mail des Absenders öffnen |
| Leertaste | neueste Mail öffnen — bzw. Vorschau, wenn eine Mail-Zeile fokussiert ist |
| ↑ / ↓ | zwischen Mail-Zeilen navigieren (aufgeklappte Liste) |
| Doppelklick | neueste Mail öffnen |
| Esc | offenes Kontextmenü schließen |

Tastatur-Shortcuts greifen nicht, wenn ein Eingabefeld aktiv ist.

---

## Installation (Entwicklung / temporär)

1. Thunderbird öffnen
2. Menü **≡** (Hamburger-Menü, oben rechts) öffnen
3. **Add-ons und Themes** wählen
4. links **Erweiterungen** wählen
5. Zahnrad **⚙** → **Add-ons debuggen**
6. **Temporäres Add-on laden…**
7. im Projektordner `mailmanager/manifest.json` auswählen

Das Add-on bleibt geladen, bis Thunderbird neu gestartet wird. Nach
Code-Änderungen in der Debug-Ansicht den **Reload ↻** neben „MailManager"
klicken.

> Hinweis: `Strg + Umschalt + A` öffnet in aktuellen Thunderbird-Versionen den
> Add-ons-Manager nicht zuverlässig — der Weg über das Hamburger-Menü wird
> empfohlen.

Ein temporär geladenes Add-on wird beim Beenden von Thunderbird automatisch
wieder entfernt — gut zum Entwickeln, nicht für den Dauerbetrieb.

---

## Feste Installation

Für den Dauerbetrieb (übersteht einen Thunderbird-Neustart) wird das Add-on als
`.xpi`-Paket installiert.

**1. Paket erstellen.** Eine `.xpi`-Datei ist ein ZIP-Archiv, in dem die
`manifest.json` direkt auf oberster Ebene liegt. Daher den **Inhalt** des
Ordners `mailmanager/` packen — nicht den Ordner selbst:

```bash
cd mailmanager
npm run build
```

Unter Windows ohne `zip`-Befehl: den **Inhalt** des `mailmanager/`-Ordners
markieren → Rechtsklick → „Senden an → ZIP-komprimierter Ordner" → die Datei
in `mailmanager.xpi` umbenennen. Wichtig ist, dass `manifest.json` im ZIP ganz
oben liegt (nicht in einem Unterordner).

**2. Signatur.** Das lokal erzeugte Paket ist nicht automatisch signiert und
kann deshalb in einer normalen Thunderbird-Installation abgelehnt werden. Für
eine öffentliche Installation das Paket über
[addons.thunderbird.net](https://addons.thunderbird.net/) signieren. Die
Signaturprüfung im Hauptprofil sollte nicht abgeschaltet werden.

**3. Installieren.**

- Menü **≡ → Add-ons und Themes → Erweiterungen**
- Zahnrad **⚙ → Add-on aus Datei installieren…**
- die `mailmanager.xpi` auswählen und die Installation bestätigen

Das Add-on bleibt nun dauerhaft installiert und nach jedem Neustart aktiv. Für
ein Update das `.xpi` neu erstellen und auf demselben Weg erneut installieren.

---

## Deinstallation

- **Fest installiert:** Menü **≡ → Add-ons und Themes → Erweiterungen →
  MailManager → ⋯ → Entfernen**
- **Temporär geladen:** Thunderbird beenden entfernt das Add-on automatisch;
  alternativ unter **Add-ons debuggen → MailManager → Entfernen**

Beim Entfernen löscht Thunderbird auch die lokal gespeicherten MailManager-Daten
(Regeln, Schutzliste, Protokoll und UI-Einstellungen in `storage.local`; der
Scan-Cache liegt nur in `storage.session`). Zuvor exportierte CSV-/JSON-Dateien
bleiben erhalten.

---

## Voraussetzungen & Tests

- **Thunderbird 153.0** oder neuer
- **Node.js 20** — für Syntax-/Unit-Tests und den XPI-Build, nicht für den Betrieb
- keine Server-Komponente, keine externe Datenbank

Syntaxprüfung:

```bash
cd mailmanager
node --check tab/tab.js
node --check background/background.js
node --check shared/utils.js
node --check tab/tab-utilities.js
```

Unit-Tests der Logik-Funktionen und gemockten Background-Schutzgrenzen:

```bash
cd mailmanager
npm test
```

Reale Thunderbird-API-Flows (Scan, Verschieben, Undo, Abmelden, Vorschau,
Anhänge) müssen zusätzlich im laufenden Thunderbird geprüft werden.

---

## Projektstruktur

```
mailmanager/
├── manifest.json            Add-on-Metadaten, Berechtigungen, Toolbar-Button
├── package.json             Node-ESM-Flag + Test-/Build-Scripts (nicht im XPI)
├── background/
│   └── background.js         Event-Page — Thunderbird-API, Scan, Aktionen
├── tab/
│   ├── tab.html              Tab-Oberfläche
│   ├── tab.css               Styles (helles Thema, Zwei-Spalten-Layout)
│   ├── tab.js                UI-Logik, Datenhaltung, Aktions-Dispatch
│   └── tab-utilities.js      testbare Filter- und UI-Hilfslogik
├── shared/
│   ├── utils.js              reine Hilfsfunktionen (Parsing, Export, Format)
│   ├── cleanup-logic.mjs     Aufräum-Score, Bulk-Erkennung, Domain-Logik
│   └── message-preview.mjs   Klartext-Auszug für die Inline-Vorschau
├── tests/
│   ├── background-safety.test.mjs
│   ├── utils.test.mjs
│   ├── cleanup-logic.test.mjs
│   ├── message-preview.test.mjs
│   └── tab-utilities.test.mjs
└── icons/                    Toolbar-Icons
```

---

## Berechtigungen

| Berechtigung | Zweck |
|---|---|
| `messagesRead` | Nachrichten lesen (Scan, Header, Vorschau, Anhänge) |
| `messagesMove` | Nachrichten verschieben (Papierkorb, In Ordner) |
| `messagesUpdate` | Tags an Nachrichten setzen |
| `messagesTags` | verfügbare Tags auflisten |
| `accountsRead` | Konten und Ordner auflisten |
| `accountsFolders` | neue Ordner anlegen |
| `compose` | Abmelde-Mail verfassen, Antwort-Fenster öffnen |
| `storage` | Regeln, Schutzliste, Protokoll, Cache, UI-Einstellungen speichern |

Bewusst **nicht** angefordert: Adressbücher, Kalender, Netzwerkzugriff.

---

## Datenschutz

MailManager arbeitet ausschließlich lokal im Thunderbird-Profil. Es gibt keinen
Server, kein Tracking, keine Telemetrie, keine Cloud-Synchronisation und keine
automatische Datenübertragung. `browser.storage.local` speichert nur
MailManager-eigene Einstellungen (Regeln, Schutzliste, Protokoll, UI-Status);
der Scan-Cache liegt in `browser.storage.session`. Export-Dateien entstehen nur,
wenn du explizit exportierst.

---

## Bekannte Grenzen

- Thunderbird-Message-IDs können sich beim Verschieben ändern; **Rückgängig**
  ist nur zuverlässig, wenn Thunderbird die neuen IDs zurückmeldet.
- Die Newsletter/Bulk-Erkennung ist heuristisch und nicht perfekt.
- `List-Unsubscribe` wird nur geprüft, wenn der Abmelde-Check gestartet wird.
- Die Inline-Vorschau zeigt nur einen Klartext-Auszug — vollständiges Lesen/
  Bearbeiten erfolgt in Thunderbird.

---

## Empfohlener Workflow

1. Konto, Ordner und Scan-Profil wählen → **▶ Scannen**
2. Aufräum-Dashboard und Schnellfilter prüfen
3. verdächtige Absender aufklappen, Mails per Vorschau ansehen
4. Newsletter/Bulk oder Speicherfresser auswählen, ggf. Abmelde-Links prüfen
5. Papierkorb-Dialog öffnen; die **Vorschau** startet automatisch und muss nach Regeländerungen erneut berechnet werden
6. Sicherheitswarnungen prüfen, **Bestätigen**
7. bei Bedarf **Rückgängig**, danach Protokoll kontrollieren

---

## Projektstatus

Version 0.1.0 — frühe Alpha mit schneller Analyse, Bulk-Aktionen, Vorschau,
lokaler Nachvollziehbarkeit und Untersuchung einzelner Mails direkt in der
Liste. Vor einer öffentlichen Veröffentlichung fehlen noch reale Thunderbird-
Integrationstests und die Signierung. Der Quellcode steht unter der
[MIT-Lizenz](../LICENSE).
