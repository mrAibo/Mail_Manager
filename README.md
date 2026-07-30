# MailManager

MailManager ist ein Thunderbird-Add-on zum **lokalen Analysieren und Aufräumen großer Postfächer**. Es gruppiert Nachrichten nach Absender oder Domain, zeigt Speicherverbrauch und Aktivität und hilft, ausgewählte Mails kontrolliert in den Papierkorb oder in einen anderen Ordner zu verschieben.

> **Projektstatus: frühe Alpha (0.1.0).** Oberfläche und Schutzmechanismen benötigen noch Integrationstests im laufenden Thunderbird. Vor Tests mit wichtigen Postfächern ein Backup anlegen und zuerst einen unkritischen Ordner verwenden.

## Was MailManager kann

- ein Konto und einen Ordner in Thunderbird scannen
- Absender und Domains nach Mail-Anzahl, Größe, Lesequote und Aktivität vergleichen
- Aufräum-Kandidaten mit einer lokalen Heuristik hervorheben
- Newsletter/Bulk-Absender und `List-Unsubscribe`-Header erkennen
- einzelne Mails oder ganze Absender auswählen
- Mails in den Papierkorb oder in einen anderen Ordner verschieben
- Thunderbird-Tags setzen
- Scan-Ergebnisse als CSV oder JSON exportieren
- Aufräum-Regeln, Schutzliste, Aktionsprotokoll und Best-Effort-Undo verwalten

Die Benutzeroberfläche ist derzeit auf Deutsch.

## Empfohlener Ablauf

1. **Konto**, **Ordner** und ein Scan-Profil wählen.
2. **Scannen** starten.
3. Kandidaten über Suche, Sortierung oder einen Schnellfilter eingrenzen.
4. Wichtige Absender schützen und verdächtige Mails stichprobenartig öffnen.
5. Automatisch berechnete **Vorschau** prüfen; nach Regeländerungen erneut berechnen.
6. Erst danach in den Papierkorb verschieben.
7. Ergebnis kontrollieren; falls Thunderbird neue Message-IDs liefert, steht im selben MailManager-Tab **Rückgängig** zur Verfügung.

Der Aufräum-Score ist nur eine Heuristik. Ein hoher Wert bedeutet *wahrscheinlich lohnender Aufräum-Kandidat*, nicht *Spam* oder *sicher löschbar*.

## Datenschutz

MailManager verarbeitet Mail-Daten im Thunderbird-Profil:

- kein eigener Server
- keine Cloud-Synchronisation
- kein Tracking und keine Telemetrie
- keine automatische Übertragung von Mail-Inhalten
- kein automatischer Mailversand

Eine `https:`-Abmelde-Adresse wird nur nach Bestätigung im Standardbrowser geöffnet. Eine `mailto:`-Abmeldung öffnet lediglich ein vorbefülltes Thunderbird-Verfassen-Fenster.

## Sicherheitsmodell und bekannte Grenzen

- Systemordner wie **Gesendet**, **Entwürfe**, **Archiv**, **Papierkorb**, **Spam** und **Postausgang** werden nicht als Scan-Ziel angeboten.
- Die normale Oberfläche verschiebt Mails in den Papierkorb; sie bietet aktuell keine Schaltfläche zum permanenten Löschen.
- Vor jeder Papierkorb-Aktion wird automatisch eine Vorschau berechnet; nach Regeländerungen bleibt **Bestätigen** bis zur erneuten Vorschau gesperrt.
- Undo ist nur zuverlässig, wenn Thunderbird nach einem Verschieben neue Message-IDs zurückmeldet.
- Der Scan-Cache liegt in `browser.storage.session` und verschwindet beim Thunderbird-Neustart. Regeln, Schutzliste, Protokoll und UI-Einstellungen liegen in `browser.storage.local`.
- Geschützte Absender und Quellordner werden vor Papierkorb-, Ordner- und Tag-Aktionen erneut im Background geprüft.
- Jeder MailManager-Tab akzeptiert nur Scan-Ereignisse seines aktiven `scanId`; Undo-Einträge sind tabbezogen.
- Der CSV-Export escaped Anführungszeichen und neutralisiert Spreadsheet-Formelpräfixe in Absenderfeldern.
- Die Bulk- und Score-Erkennung ist heuristisch und kann falsch liegen.
- Es gibt noch keine signierte Veröffentlichung, keinen GitHub Release und keine festgelegte Lizenz.

## Voraussetzungen

- Thunderbird **150.0 oder neuer** (laut `manifest.json`)
- Node.js **20** für Tests und Paketbau (CI-Baseline)
- `zip` für den XPI-Paketbau

## Entwicklung

```bash
git clone https://github.com/mrAibo/Mail_Manager.git
cd Mail_Manager/mailmanager
npm test
```

Temporär in Thunderbird laden:

1. **≡ → Add-ons und Themes → Erweiterungen** öffnen.
2. **⚙ → Add-ons debuggen** wählen.
3. **Temporäres Add-on laden…** anklicken.
4. `mailmanager/manifest.json` auswählen.

Nach Änderungen in der Debug-Ansicht **Neu laden** anklicken. Das temporäre Add-on wird beim Beenden von Thunderbird entfernt.

## XPI bauen

```bash
cd mailmanager
npm run build
```

Das erzeugt `mailmanager.xpi` im Repository-Root. Der Build löscht den alten Archivinhalt zuerst und schließt Tests sowie `node_modules` aus.

Das erzeugte Paket ist nicht automatisch signiert. Für eine öffentliche Installation sollte es über [addons.thunderbird.net](https://addons.thunderbird.net/) signiert und als versionierter GitHub Release veröffentlicht werden. Die Signaturprüfung im normalen Thunderbird-Profil sollte dafür **nicht** abgeschaltet werden.

## Tests

```bash
cd mailmanager
npm test
node --check tab/tab.js
node --check background/background.js
node --check shared/utils.js
node --check tab/tab-utilities.js
```

Die Unit-Tests decken Score-, Filter-, Export- und Vorschau-Logik sowie die
Background-Schutzgrenzen mit gemockten Thunderbird-APIs ab. Reale Scan-,
Verschiebe- und Undo-Flows benötigen zusätzlich Integrationstests im laufenden Thunderbird.

## Berechtigungen

| Berechtigung | Verwendung |
|---|---|
| `accountsRead` | Konten und Ordner lesen |
| `accountsFolders` | Zielordner anlegen |
| `messagesRead` | Header, Vorschau und Anhänge lesen |
| `messagesMove` | Mails in Papierkorb oder Ordner verschieben |
| `messagesUpdate`, `messagesTags` | Thunderbird-Tags lesen und setzen |
| `compose` | Antwort- oder Abmeldeentwurf öffnen |
| `storage` | Regeln, Schutzliste, Protokoll und Einstellungen speichern |

## Projektstruktur

```text
.github/workflows/ci.yml          # Unit-Tests, Syntaxprüfung und XPI-Build
mailmanager/
├── manifest.json
├── background/background.js   # Thunderbird-API, Scan und Aktionen
├── tab/
│   ├── tab.html
│   ├── tab.css
│   ├── tab.js                 # UI und Zustandsverwaltung
│   └── tab-utilities.js
├── shared/                    # testbare Logik ohne Thunderbird-API
└── tests/                     # Node.js-Unit-Tests
```

Weitere technische Details stehen in [`mailmanager/README.md`](mailmanager/README.md), Änderungen in [`CHANGELOG.md`](CHANGELOG.md).

## Nächste sinnvolle Schritte

1. Background-/UI-Integrationstests im laufenden Thunderbird ergänzen.
2. Lizenz festlegen und signierte Releases veröffentlichen.
