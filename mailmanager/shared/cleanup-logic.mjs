export function computeCleanupScore(entry, now = new Date()) {
  const { count, readCount, oldestDate, newestDate } = entry;

  if (!count || count <= 0) return 0;

  const oldest = oldestDate instanceof Date ? oldestDate : new Date(oldestDate);
  const newest = newestDate instanceof Date ? newestDate : new Date(newestDate);
  const nowDate = now instanceof Date ? now : new Date(now);

  if (
    Number.isNaN(oldest.getTime()) ||
    Number.isNaN(newest.getTime()) ||
    Number.isNaN(nowDate.getTime())
  ) {
    return 0;
  }

  const spanDays = Math.max(1, (newest - oldest) / 86400000);
  const volume = Math.min(1, (count / spanDays * 30) / 50);
  const unreadRate = Math.max(0, Math.min(1, (count - (readCount || 0)) / count));
  const inactivity = Math.min(1, Math.max(0, (nowDate - newest) / 86400000 / 365));

  return Math.round(
    Math.max(0, Math.min(1, volume * 0.35 + unreadRate * 0.40 + inactivity * 0.25)) * 100
  );
}

export function computeBulkScore(email, displayName = "", sampleSubjects = []) {
  const text = [
    email || "",
    displayName || "",
    ...(sampleSubjects || []),
  ].join(" ").toLowerCase();

  let score = 0;
  const reasons = [];

  const emailPatterns = [
    "newsletter",
    "news",
    "noreply",
    "no-reply",
    "donotreply",
    "do-not-reply",
    "notification",
    "notifications",
    "mailing",
    "marketing",
    "offers",
    "angebot",
    "angebote",
    "promo",
    "promotion",
    "sale",
    "shop",
    "store",
    "info@",
    "service@",
    "support@",
  ];

  for (const pattern of emailPatterns) {
    if (text.includes(pattern)) {
      score += 15;
      reasons.push(pattern);
      break;
    }
  }

  const subjectPatterns = [
    "newsletter",
    "angebot",
    "angebote",
    "rabatt",
    "sale",
    "aktion",
    "black friday",
    "cyber monday",
    "unsubscribe",
    "abmelden",
    "webinar",
    "update",
    "neuigkeiten",
    "deals",
    "voucher",
    "gutschein",
  ];

  for (const pattern of subjectPatterns) {
    if (text.includes(pattern)) {
      score += 20;
      reasons.push(pattern);
      break;
    }
  }

  if (/@.*(mail|newsletter|news|marketing|promo|shop|store)/i.test(email || "")) {
    score += 20;
    reasons.push("domain-pattern");
  }

  return {
    bulkScore: Math.min(100, score),
    isBulkCandidate: score >= 20,
    bulkReasons: [...new Set(reasons)],
  };
}

export const COMMON_SUBDOMAIN_PREFIXES = new Set([
  "mail",
  "email",
  "newsletter",
  "news",
  "tracking",
  "track",
  "click",
  "links",
  "link",
  "bounce",
  "bounces",
  "smtp",
  "mx",
  "mta",
  "notify",
  "notification",
  "notifications",
  "no-reply",
  "noreply",
  "marketing",
  "promo",
  "shop",
  "store",
  "support",
  "service",
  "info",
]);

export const COMMON_SECOND_LEVEL_SUFFIXES = new Set([
  "co",
  "com",
  "net",
  "org",
  "gov",
  "ac",
  "edu",
]);

export function emailHost(email) {
  const host = String(email || "")
    .trim()
    .toLowerCase()
    .split("@")[1] || "";

  return host
    .replace(/[>\s]+$/g, "")
    .replace(/^\.+|\.+$/g, "");
}

export function normalizeDomain(hostOrEmail) {
  let host = String(hostOrEmail || "").trim().toLowerCase();

  if (host.includes("@")) {
    host = emailHost(host);
  }

  host = host
    .replace(/[>\s]+$/g, "")
    .replace(/^\.+|\.+$/g, "");

  if (!host) return "unbekannt";

  const labels = host
    .split(".")
    .map(part => part.trim())
    .filter(Boolean);

  if (labels.length <= 2) return labels.join(".") || "unbekannt";

  while (labels.length > 2 && COMMON_SUBDOMAIN_PREFIXES.has(labels[0])) {
    labels.shift();
  }

  if (labels.length <= 2) return labels.join(".");

  const tld = labels.at(-1);
  const second = labels.at(-2);

  if (
    tld.length === 2 &&
    COMMON_SECOND_LEVEL_SUFFIXES.has(second) &&
    labels.length >= 3
  ) {
    return labels.slice(-3).join(".");
  }

  return labels.slice(-2).join(".");
}

export function isInactiveForDays(dateValue, days, now = new Date()) {
  const d = dateValue instanceof Date ? dateValue : new Date(dateValue);
  const nowDate = now instanceof Date ? now : new Date(now);

  if (Number.isNaN(d.getTime()) || Number.isNaN(nowDate.getTime())) return false;

  return nowDate.getTime() - d.getTime() >= days * 86400000;
}

export function senderReadRate(sender) {
  if (!sender || sender.count <= 0) return 0;
  return (sender.readCount || 0) / sender.count;
}

export function looksLikePersonalSender(sender) {
  const email = String(sender?.email || "").toLowerCase();
  const displayName = String(sender?.displayName || "").toLowerCase();

  if (sender?.isBulkCandidate || sender?.hasUnsubscribe) return false;

  const bulkWords = [
    "newsletter",
    "noreply",
    "no-reply",
    "notification",
    "notifications",
    "marketing",
    "service",
    "support",
    "shop",
    "store",
    "angebote",
    "angebot",
    "promo",
    "info@",
  ];

  if (bulkWords.some(word => email.includes(word) || displayName.includes(word))) {
    return false;
  }

  return true;
}

export function isProtectionCandidate(sender, now = new Date()) {
  if (!sender?.email) return false;
  if (sender.isProtected) return false;
  if (sender.isBulkCandidate || sender.hasUnsubscribe) return false;

  const isRecent = !sender.newestDate
    ? false
    : !isInactiveForDays(sender.newestDate, 30, now);

  const isTiny = (sender.count || 0) <= 3;
  const isMostlyRead = (sender.count || 0) >= 5 && senderReadRate(sender) >= 0.75;
  const isPersonal = looksLikePersonalSender(sender);

  return isPersonal && (isRecent || isTiny || isMostlyRead);
}

export function suggestCleanupRuleForSenders(senders, now = new Date()) {
  const list = Array.isArray(senders) ? senders : [];
  const senderCount = list.length;

  if (senderCount === 0) return null;

  const mailCount = list.reduce((sum, sender) => sum + (sender.count || 0), 0);
  const sizeBytes = list.reduce((sum, sender) => sum + (sender.totalSizeBytes || 0), 0);

  const bulkCount = list.filter(sender => sender.isBulkCandidate).length;
  const unsubscribeCount = list.filter(sender => sender.hasUnsubscribe).length;
  const inactiveCount = list.filter(sender => isInactiveForDays(sender.newestDate, 365, now)).length;
  const highScoreCount = list.filter(sender => (sender.riskScore || 0) >= 70).length;

  const bulkRate = bulkCount / senderCount;
  const unsubscribeRate = unsubscribeCount / senderCount;
  const inactiveRate = inactiveCount / senderCount;
  const highScoreRate = highScoreCount / senderCount;

  if (bulkRate >= 0.7 || unsubscribeRate >= 0.5) {
    return {
      olderThanDays: 90,
      keepNewest: 3,
      title: "Newsletter/Bulk-Auswahl",
    };
  }

  if (inactiveRate >= 0.7) {
    return {
      olderThanDays: 365,
      keepNewest: 1,
      title: "Inaktive Absender",
    };
  }

  if (sizeBytes >= 500 * 1024 * 1024) {
    return {
      olderThanDays: 365,
      keepNewest: 5,
      title: "Speicherfresser",
    };
  }

  if (highScoreRate >= 0.5 || mailCount >= 500) {
    return {
      olderThanDays: 365,
      keepNewest: 5,
      title: "Große Aufräum-Auswahl",
    };
  }

  return {
    olderThanDays: 365,
    keepNewest: 5,
    title: "Sicherer Standard",
  };
}
