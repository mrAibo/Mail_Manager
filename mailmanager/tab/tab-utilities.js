// MailManager — Tab Utilities
// Reine Hilfsfunktionen ohne externe Dependencies

const TOOLTIP_FALLBACKS = {
  cleanupScoreTooltipScore: "Aufräum-Score: $1/100",
  cleanupScoreTooltipMeaning: "Bedeutung:",
  cleanupScoreTooltipHigh: "Hoher Wert = guter Kandidat zum Aufräumen.",
  cleanupScoreTooltipSafe: "Kein Spam- oder Sicherheitsrisiko.",
  cleanupScoreTooltipMails: "Mails: $1",
  cleanupScoreTooltipUnread: "Ungelesen: $1 ($2%)",
  cleanupScoreTooltipLastUnknown: "Letzte Mail: unbekannt",
  cleanupScoreTooltipLastDays: "Letzte Mail vor: $1 Tag(en)",
};
const _ = (key, subs = []) => globalThis.browser?.i18n?.getMessage?.(key, subs)
  || TOOLTIP_FALLBACKS[key]?.replace("$1", subs[0]).replace("$2", subs[1]) || key;

/**
 * Escapet HTML-Sonderzeichen um XSS zu verhindern.
 */
export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/**
 * Berechnet die Tage seit einem Datum.
 */
export function daysSince(dateValue) {
  // new Date(null) ergibt die Epoche (1970) statt eines ungültigen Datums —
  // null/undefined daher explizit als "unbekannt" behandeln.
  if (dateValue == null) return null;
  const d = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.round((Date.now() - d.getTime()) / 86400000));
}

/**
 * Prüft, ob ein Absender die erweiterten Filterkriterien erfüllt.
 * Nicht gesetzte Kriterien (null/undefined) bedeuten "kein Constraint".
 *
 * @param {object} sender - SenderEntry mit count, readCount, totalSizeBytes, newestDate
 * @param {object} filter - {
 *   sizeMinMB, sizeMaxMB,            // Gesamtgröße in MB
 *   lastMailDaysMin, lastMailDaysMax, // Tage seit der letzten Mail
 *   readStatus                       // "all" | "read" | "unread"
 * }
 * @returns {boolean} true, wenn der Absender alle gesetzten Kriterien erfüllt.
 */
export function matchesAdvancedFilter(sender, filter) {
  if (!filter || !sender) return true;

  const { sizeMinMB, sizeMaxMB, lastMailDaysMin, lastMailDaysMax, readStatus } = filter;

  const sizeMB = (sender.totalSizeBytes || 0) / (1024 * 1024);
  if (sizeMinMB != null && sizeMB < sizeMinMB) return false;
  if (sizeMaxMB != null && sizeMB > sizeMaxMB) return false;

  if (lastMailDaysMin != null || lastMailDaysMax != null) {
    const age = daysSince(sender.newestDate);
    // Unbekanntes Datum kann einen Datums-Constraint nicht erfüllen.
    if (age === null) return false;
    if (lastMailDaysMin != null && age < lastMailDaysMin) return false;
    if (lastMailDaysMax != null && age > lastMailDaysMax) return false;
  }

  const count = sender.count || 0;
  const readCount = sender.readCount || 0;
  if (readStatus === "read" && readCount < count) return false;
  if (readStatus === "unread" && readCount >= count) return false;

  return true;
}

export function isCurrentScanMessage(message, activeScanId) {
  return Boolean(activeScanId && message?.scanId === activeScanId);
}

export function canConfirmTrash(previewReady, hasHighWarning, warningsConfirmed) {
  return Boolean(previewReady && (!hasHighWarning || warningsConfirmed));
}

export function isCurrentPreviewRequest(requestId, activeRequestId) {
  return requestId === activeRequestId;
}

/**
 * Prüft, ob ein Element ein echtes Texteingabe-Ziel ist — ein Feld, in dem
 * Tasten wie Entf eine native Bedeutung haben und Tastaturkürzel daher nicht
 * feuern sollten. Checkboxen, Radio- und sonstige Buttons zählen NICHT dazu:
 * dort hat z. B. Entf keine native Funktion.
 *
 * @param {{tagName?: string, isContentEditable?: boolean,
 *          getAttribute?: (name: string) => string|null}} el
 * @returns {boolean}
 */
export function isTextEntryTarget(el) {
  if (!el) return false;

  const tag = el.tagName?.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (el.isContentEditable) return true;

  if (tag === "input") {
    const type = (el.getAttribute?.("type") || "text").toLowerCase();
    return !["checkbox", "radio", "button", "submit", "reset", "file"].includes(type);
  }

  return false;
}

/**
 * Erstellt einen Tooltip-Text für den Aufräum-Score.
 * Benötigt: entry.count, entry.readCount, entry.riskScore, entry.newestDate
 */
export function cleanupScoreTooltip(entry) {
  const unreadCount = Math.max(0, entry.count - entry.readCount);
  const unreadPct = entry.count > 0 ? Math.round((unreadCount / entry.count) * 100) : 0;
  const inactiveDays = daysSince(entry.newestDate);

  return [
    _("cleanupScoreTooltipScore", [entry.riskScore]),
    "",
    _("cleanupScoreTooltipMeaning"),
    _("cleanupScoreTooltipHigh"),
    _("cleanupScoreTooltipSafe"),
    "",
    _("cleanupScoreTooltipMails", [entry.count]),
    _("cleanupScoreTooltipUnread", [unreadCount, unreadPct]),
    inactiveDays === null ? _("cleanupScoreTooltipLastUnknown") : _("cleanupScoreTooltipLastDays", [inactiveDays]),
  ].join("\n");
}
