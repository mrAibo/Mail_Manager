// Pure utility functions — no browser API calls, no side effects
// Implemented in Tasks 2–4

/**
 * Parses a Thunderbird message author string.
 * Handles: "Display Name <email@example.com>" and bare "email@example.com"
 * @param {string} author
 * @returns {{ email: string, displayName: string }}
 */
export function parseAuthor(author) {
  if (!author) return { email: "", displayName: "" };
  const match = author.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
  if (match) {
    return { displayName: match[1].trim(), email: match[2].trim().toLowerCase() };
  }
  return { email: author.trim().toLowerCase(), displayName: "" };
}

/**
 * Risk score 0–100. Higher = more likely cleanup candidate.
 * @param {{ count:number, readCount:number, oldestDate:Date, newestDate:Date }} entry
 * @param {Date} [now]
 * @returns {number}
 */
export function computeRiskScore(entry, now = new Date()) {
  const { count, readCount, oldestDate, newestDate } = entry;
  if (count === 0) return 0;
  const spanDays      = Math.max(1, (newestDate - oldestDate) / 86400000);
  const volumen       = Math.min(1, (count / spanDays * 30) / 50);   // mails/month, cap 50
  const ungelesenRate = (count - readCount) / count;
  const inaktivität   = Math.min(1, (now - newestDate) / 86400000 / 365);
  const raw = volumen * 0.35 + ungelesenRate * 0.40 + inaktivität * 0.25;
  return Math.round(Math.max(0, Math.min(1, raw)) * 100);
}

/**
 * @param {number} bytes
 * @returns {string}
 */
export function formatSize(bytes) {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
  if (bytes >= 1024)    return (bytes / 1024).toFixed(1) + " KB";
  return bytes + " B";
}

/**
 * German relative date string.
 * @param {Date} date
 * @param {Date} [now]
 * @returns {string}
 */
export function formatRelativeDate(date, now = new Date()) {
  const days = Math.floor((now - date) / 86400000);
  if (days === 0) return "heute";
  if (days === 1) return "gestern";
  if (days < 7)   return `vor ${days} Tagen`;
  const months = Math.round(days / 30);
  if (months < 12) return `vor ${months} Mon.`;
  return date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/**
 * @param {unknown} value
 * @param {boolean} neutralizeFormula
 * @returns {string}
 */
function csvCell(value, neutralizeFormula = false) {
  let text = String(value ?? "");
  if (neutralizeFormula && /^[\s\u0000-\u001F]*[=+\-@]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * @param {SenderEntry[]} senders
 * @returns {string} CSV string
 */
export function toCSV(senders) {
  const header = "email,displayName,count,totalSizeMB,readPercent,oldestDate,newestDate,riskScore";
  const rows = senders.map(s => {
    const readPct = s.count > 0 ? Math.round((s.readCount / s.count) * 100) : 0;
    return [
      csvCell(s.email, true), csvCell(s.displayName, true), s.count,
      (s.totalSizeBytes / 1048576).toFixed(1),
      readPct,
      s.oldestDate.toISOString().slice(0, 10),
      s.newestDate.toISOString().slice(0, 10),
      s.riskScore,
    ].join(",");
  });
  return [header, ...rows].join("\n");
}

/**
 * @param {SenderEntry[]} senders
 * @returns {string} JSON string
 */
export function toJSON(senders) {
  return JSON.stringify(senders.map(s => ({
    email:        s.email,
    displayName:  s.displayName,
    count:        s.count,
    totalSizeMB:  parseFloat((s.totalSizeBytes / 1048576).toFixed(1)),
    readPercent:  s.count > 0 ? Math.round((s.readCount / s.count) * 100) : 0,
    oldestDate:   s.oldestDate.toISOString().slice(0, 10),
    newestDate:   s.newestDate.toISOString().slice(0, 10),
    riskScore:    s.riskScore,
    sampleSubjects: s.sampleSubjects,
  })), null, 2);
}
