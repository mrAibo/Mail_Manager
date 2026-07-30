/**
 * Reine Hilfsfunktionen, um aus einem browser.messages.getFull()-Ergebnis
 * einen kurzen Klartext-Auszug für die Inline-Vorschau zu gewinnen.
 */

/** Entfernt HTML-Tags und dekodiert ein paar häufige Entities. */
function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

/** Sucht rekursiv den Body des ersten Teils, dessen contentType passt. */
function findPartBody(part, contentTypePrefix) {
  if (!part || typeof part !== "object") return null;

  const ct = typeof part.contentType === "string" ? part.contentType.toLowerCase() : "";
  if (ct.startsWith(contentTypePrefix) && typeof part.body === "string" && part.body.trim()) {
    return part.body;
  }

  if (Array.isArray(part.parts)) {
    for (const child of part.parts) {
      const found = findPartBody(child, contentTypePrefix);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Extrahiert einen kurzen Klartext-Auszug aus einem getFull()-Nachrichtenbaum.
 * @param {object} fullMessage - MessagePart-Baum aus browser.messages.getFull()
 * @param {{maxLines?: number, maxChars?: number}} [opts]
 * @returns {string}
 */
export function extractPreviewText(fullMessage, opts = {}) {
  const maxLines = opts.maxLines ?? 10;
  const maxChars = opts.maxChars ?? 800;

  let text = findPartBody(fullMessage, "text/plain");
  if (!text) {
    const html = findPartBody(fullMessage, "text/html");
    if (html) text = stripHtml(html);
  }
  if (!text) return "";

  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(line => line.replace(/\s+/g, " ").trim())
    .filter(line => line.length > 0);

  let result = lines.slice(0, maxLines).join("\n");
  if (result.length > maxChars) {
    result = result.slice(0, maxChars).trimEnd() + "…";
  }
  return result;
}
