// MailManager — Background Event Page (non-persistent — holds NO long-lived state)

// ─── Toolbar button opens the tab ────────────────────────────────────────────
browser.action.onClicked.addListener(() => {
  browser.tabs.create({ url: browser.runtime.getURL("tab/tab.html") });
});
// Active scan cancellation state. Keyed by scanId generated in tab.js.
const activeScans = new Map();

// ─── Message router ───────────────────────────────────────────────────────────
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  handleMessage(message, tabId)
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message }));
  return true; // async response
});

async function handleMessage(message, tabId) {
  switch (message.action) {
    case "getAccounts":        return handleGetAccounts();
    case "diagnostics":        return handleDiagnostics(message.accountId || null);
    case "scan":               return handleScan(message.accountId, message.folderId, message.scanId, tabId, message.options || {});
    case "cancelScan":         return handleCancelScan(message.scanId);
    case "performAction":      return handlePerformAction(message.type, message.messageIds, message.accountId, message.folderId, message.options || {});
    case "previewTrash":       return handlePreviewTrash(message.messageIds || [], message.options || {});
    case "undo":               return handleUndo();
    case "toggleProtect":      return handleToggleProtect(message.email, message.protect, message.kind);
    case "protectEmails":      return handleProtectEmails(message.emails || [], message.protect !== false);
    case "setProtectedEmails": return handleSetProtectedEmails(message.emails || []);
    case "getUnsubscribeInfo": return handleGetUnsubscribeInfo(message.messageId);
    case "checkUnsubscribeForSenders": return handleCheckUnsubscribeForSenders(message.senderGroups || [], message.limitPerSender || 3);
    case "doCompose":          return handleDoCompose(message.to, message.subject);
    case "openMessage":         return handleOpenMessage(message.messageId);
    default:                   return { error: "Unknown action: " + message.action };
  }
}

async function handleOpenMessage(messageId) {
  if (!messageId) return { error: "Keine messageId angegeben." };

  await browser.messageDisplay.open({
    messageId,
    location: "tab",
    active: true,
  });

  return { success: true };
}

// ─── Inline utilities (identical logic to shared/utils.js) ───────────────────
function parseAuthor(author) {
  if (!author) return { email: "", displayName: "" };
  const match = author.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
  if (match) return { displayName: match[1].trim(), email: match[2].trim().toLowerCase() };
  return { email: author.trim().toLowerCase(), displayName: "" };
}

function computeRiskScore(entry, now = new Date()) {
  const { count, readCount, oldestDate, newestDate } = entry;
  if (count === 0) return 0;
  const spanDays      = Math.max(1, (newestDate - oldestDate) / 86400000);
  const volumen       = Math.min(1, (count / spanDays * 30) / 50);
  const ungelesenRate = (count - readCount) / count;
  const inaktivität   = Math.min(1, (now - newestDate) / 86400000 / 365);
  return Math.round(Math.max(0, Math.min(1, volumen * 0.35 + ungelesenRate * 0.40 + inaktivität * 0.25)) * 100);
}

function computeBulkScore(email, displayName, sampleSubjects) {
  const text = [
    email || "",
    displayName || "",
    ...(sampleSubjects || []),
  ].join(" ").toLowerCase();

  let score = 0;
  const reasons = [];

  const emailPatterns = [
    "newsletter", "news", "noreply", "no-reply", "donotreply", "do-not-reply",
    "notification", "notifications", "mailing", "marketing", "offers",
    "angebot", "angebote", "promo", "promotion", "sale", "shop", "store",
    "info@", "service@", "support@",
  ];

  for (const pattern of emailPatterns) {
    if (text.includes(pattern)) {
      score += 15;
      reasons.push(pattern);
      break;
    }
  }

  const subjectPatterns = [
    "newsletter", "angebot", "angebote", "rabatt", "sale", "aktion",
    "black friday", "cyber monday", "unsubscribe", "abmelden",
    "webinar", "update", "neuigkeiten", "deals", "voucher", "gutschein",
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

// ─── Scan filter helpers ──────────────────────────────────────────────────────
function ageDaysForScan(dateValue, now = Date.now()) {
  const d = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (Number.isNaN(d.getTime())) return 0;
  return Math.max(0, Math.floor((now - d.getTime()) / 86400000));
}

function messageLooksBulk(msg) {
  const author = String(msg?.author || "").toLowerCase();
  const subject = String(msg?.subject || "").toLowerCase();

  const text = `${author} ${subject}`;

  return [
    "newsletter",
    "noreply",
    "no-reply",
    "notification",
    "notifications",
    "marketing",
    "angebot",
    "angebote",
    "promo",
    "sale",
    "shop",
    "store",
    "rabatt",
    "aktion",
    "deals",
    "gutschein",
  ].some(token => text.includes(token));
}

function shouldIncludeMessageInScan(msg, options = {}, now = Date.now()) {
  if (!msg) return false;

  const age = ageDaysForScan(msg.date, now);

  if (options.olderThanDays > 0 && age < options.olderThanDays) {
    return false;
  }

  if (options.unreadOnly && msg.read) {
    return false;
  }

  if (options.bulkOnly && !messageLooksBulk(msg)) {
    return false;
  }

  if (options.cleanupCandidatesOnly) {
    const isOld = age >= 365;
    const isUnread = !msg.read;
    const isLarge = (msg.size || 0) >= 1024 * 1024;
    const isBulk = messageLooksBulk(msg);

    return isOld || isUnread || isLarge || isBulk;
  }

  return true;
}

// ─── Folder tree helpers ──────────────────────────────────────────────────────
// accounts.list(true) populates account.rootFolder.subFolders recursively.
const EXCLUDED_TYPES = new Set(["sent", "drafts", "archives", "trash", "junk", "outbox"]);

async function handleGetAccounts() {
  const { protectedFolderIds, protectedEmails } = await loadProtected();
  const rawAccounts = await browser.accounts.list(true);
  const accounts = rawAccounts.map(account => ({
    id:   account.id,
    name: account.name,
    folders: account.rootFolder
      ? collectFolders(account.rootFolder.subFolders || [], protectedFolderIds)
      : [],
  }));
  return { accounts, protectedFolderIds, protectedEmails };
}

function collectAllFoldersForDiagnostics(folders, prefix = "") {
  const result = [];

  for (const folder of folders || []) {
    const path = prefix ? `${prefix}/${folder.name}` : folder.name;

    result.push({
      id: folder.id,
      name: folder.name,
      path,
      type: folder.type || "",
      subFolderCount: folder.subFolders?.length || 0,
    });

    if (folder.subFolders?.length) {
      result.push(...collectAllFoldersForDiagnostics(folder.subFolders, path));
    }
  }

  return result;
}

async function handleDiagnostics(accountId = null) {
  const manifest = browser.runtime.getManifest();
  const { protectedFolderIds, protectedEmails } = await loadProtected();
  const rawAccounts = await browser.accounts.list(true);

  const accounts = rawAccounts.map(account => ({
    id: account.id,
    name: account.name,
    folderCount: account.rootFolder
      ? collectAllFoldersForDiagnostics(account.rootFolder.subFolders || []).length
      : 0,
  }));

  const selectedAccount = accountId
    ? rawAccounts.find(account => account.id === accountId)
    : rawAccounts[0];

  const selectedFolders = selectedAccount?.rootFolder
    ? collectAllFoldersForDiagnostics(selectedAccount.rootFolder.subFolders || [])
    : [];

  return {
    success: true,
    generatedAt: new Date().toISOString(),
    extension: {
      name: manifest.name,
      version: manifest.version,
      manifestVersion: manifest.manifest_version,
      thunderbirdMinVersion:
        manifest.browser_specific_settings?.gecko?.strict_min_version || "",
    },
    accounts,
    selectedAccount: selectedAccount
      ? {
          id: selectedAccount.id,
          name: selectedAccount.name,
          folders: selectedFolders,
        }
      : null,
    protected: {
      protectedEmailCount: protectedEmails.length,
      protectedFolderCount: protectedFolderIds.length,
    },
  };
}

// Flattens the folder tree, dropping excluded system folders.
function collectFolders(folders, protectedFolderIds) {
  const result = [];
  for (const folder of folders) {
    if (!EXCLUDED_TYPES.has(folder.type)) {
      result.push({
        id:        folder.id,
        name:      folder.name,
        type:      folder.type,
        protected: protectedFolderIds.includes(folder.id),
      });
    }
    if (folder.subFolders?.length) {
      result.push(...collectFolders(folder.subFolders, protectedFolderIds));
    }
  }
  return result;
}

async function findFolder(accountId, folderId) {
  const accounts = await browser.accounts.list(true);
  const account  = accounts.find(a => a.id === accountId);
  if (!account?.rootFolder) return null;
  return searchTree(account.rootFolder.subFolders || [], f => f.id === folderId);
}

async function findFolderByType(accountId, type) {
  const accounts = await browser.accounts.list(true);
  const account  = accounts.find(a => a.id === accountId);
  if (!account?.rootFolder) return null;
  return searchTree(account.rootFolder.subFolders || [], f => f.type === type);
}

function normalizeFolderName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

const TRASH_FOLDER_NAMES = new Set([
  "trash",
  "papierkorb",
  "deleted",
  "deleted items",
  "deleted messages",
  "geloscht",
  "geloschte elemente",
  "geloschte objekte",
  "bin",
  "wastebasket",
]);

async function findTrashFolder(accountId) {
  const accounts = await browser.accounts.list(true);
  const account = accounts.find(a => a.id === accountId);
  if (!account?.rootFolder) return null;

  const folders = account.rootFolder.subFolders || [];

  // First try the official/special folder type.
  const byType = searchTree(folders, f => String(f.type || "").toLowerCase() === "trash");
  if (byType) return byType;

  // Fallback for accounts/providers where Thunderbird does not expose type="trash".
  return searchTree(folders, f => TRASH_FOLDER_NAMES.has(normalizeFolderName(f.name)));
}

async function listFolderDebugNames(accountId) {
  const accounts = await browser.accounts.list(true);
  const account = accounts.find(a => a.id === accountId);
  if (!account?.rootFolder) return [];

  const result = [];

  function walk(folders, prefix = "") {
    for (const f of folders || []) {
      result.push(`${prefix}${f.name} [type=${f.type || "-"} id=${f.id}]`);
      if (f.subFolders?.length) walk(f.subFolders, `${prefix}${f.name}/`);
    }
  }

  walk(account.rootFolder.subFolders || []);
  return result;
}

function searchTree(folders, predicate) {
  for (const f of folders) {
    if (predicate(f)) return f;
    if (f.subFolders?.length) {
      const found = searchTree(f.subFolders, predicate);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Moves messages and returns their NEW ids (IDs change on move).
 * Correlates browser.messages.onMoved original→moved lists by index.
 *
 * browser.messages.move is atomic over the whole array — a single stale ID
 * makes the entire batch fail. To stay robust, the batch move is retried
 * message-by-message on failure so valid messages still move; invalid IDs
 * are counted as failures rather than silently dropping the whole operation.
 *
 * @param {number[]} messageIds
 * @param {object} destination  MailFolder
 * @returns {Promise<{newIds: number[], failedCount: number, movedCount: number}>}
 */
function moveAndTrackIds(messageIds, destination) {
  return new Promise((resolve) => {
    const wanted = new Set(messageIds);
    const newIds = [];
    let failedCount = 0;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      browser.messages.onMoved.removeListener(listener);
      clearTimeout(timer);
      resolve({ newIds, failedCount, movedCount: messageIds.length - failedCount });
    };

    const listener = (originalMessages, movedMessages) => {
      const orig = originalMessages.messages;
      const moved = movedMessages.messages;
      for (let i = 0; i < orig.length; i++) {
        if (wanted.has(orig[i].id)) {
          wanted.delete(orig[i].id);
          if (moved[i]) newIds.push(moved[i].id);
        }
      }
      if (wanted.size === 0) finish();
    };

    const timer = setTimeout(finish, 8000); // safety net
    browser.messages.onMoved.addListener(listener);

    moveResilient().then(() => {
      // Tracking abgeschlossen, sobald jede verschobene Mail ein onMoved-Event
      // erzeugt hat. Steht keines mehr aus, sofort abschließen.
      if (wanted.size === 0) finish();
    });

    async function moveResilient() {
      try {
        await browser.messages.move(messageIds, destination.id, { isUserAction: true });
      } catch {
        // Eine veraltete ID hat den atomaren Batch-Move scheitern lassen —
        // einzeln nachholen, ungültige IDs zählen und überspringen.
        for (const id of messageIds) {
          try {
            await browser.messages.move([id], destination.id, { isUserAction: true });
          } catch {
            failedCount++;
            wanted.delete(id); // erzeugt nie ein onMoved-Event
          }
        }
      }
    }
  });
}

// ─── Scan engine ──────────────────────────────────────────────────────────────
function sendScanMessage(payload) {
  browser.runtime.sendMessage(payload).catch(() => {});
}

function makeFallbackScanId() {
  return `scan-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function handleCancelScan(scanId) {
  if (!scanId) return { error: "Keine scanId angegeben." };

  const scan = activeScans.get(scanId);
  if (!scan) return { cancelled: false, reason: "Scan läuft nicht mehr." };

  scan.cancelled = true;
  return { cancelled: true };
}

async function handleScan(accountId, folderId, scanId, tabId, options = {}) {
  const effectiveScanId = scanId || makeFallbackScanId();

  if (activeScans.has(effectiveScanId)) {
    return { error: "Dieser Scan läuft bereits." };
  }

  const scan = { cancelled: false, tabId };
  activeScans.set(effectiveScanId, scan);

  try {
    const folder = await findFolder(accountId, folderId);
    if (!folder) return { error: `Ordner ${folderId} nicht gefunden` };

    let total = 0;
    try {
      const info = await browser.folders.getFolderInfo(folderId);
      total = info.totalMessageCount || 0;
    } catch {
      total = 0;
    }

    const senders = {};
    let processed = 0;
    let lastProgressSentAt = 0;

    function maybeSendProgress(force = false) {
      const now = Date.now();

      if (!force && now - lastProgressSentAt < 250) {
        return;
      }

      lastProgressSentAt = now;

      sendScanMessage({
        type: "scan-progress",
        scanId: effectiveScanId,
        processed,
        total: Math.max(total, processed),
      });
    }

    if (scan.cancelled) {
      sendScanMessage({ type: "scan-cancelled", scanId: effectiveScanId, processed, total });
      return { cancelled: true };
    }

    let page = await browser.messages.list(folderId);

    while (true) {
      if (scan.cancelled) {
        sendScanMessage({
          type: "scan-cancelled",
          scanId: effectiveScanId,
          processed,
          total: Math.max(total, processed),
        });
        return { cancelled: true };
      }

      for (const msg of page.messages) {
        if (scan.cancelled) {
          sendScanMessage({
            type: "scan-cancelled",
            scanId: effectiveScanId,
            processed,
            total: Math.max(total, processed),
          });
          return { cancelled: true };
        }

        if (!shouldIncludeMessageInScan(msg, options, Date.now())) {
          processed++;
          continue;
        }

        const { email, displayName } = parseAuthor(msg.author);
        if (!email) continue;

        if (!senders[email]) {
          senders[email] = {
            email,
            displayName: displayName || email,
            messageIds: [],
            _msgDates: [],
            newestMessageId: msg.id,
            count: 0,
            totalSizeBytes: 0,
            oldestDate: new Date(msg.date),
            newestDate: new Date(msg.date),
            readCount: 0,
            riskScore: 0,
            sampleSubjects: [],
          };
        }

        const e = senders[email];
        e.messageIds.push(msg.id);
        e._msgDates.push({ id: msg.id, t: new Date(msg.date).getTime() });
        e.count++;
        e.totalSizeBytes += msg.size || 0;
        if (msg.read) e.readCount++;

        const d = new Date(msg.date);
        if (d < e.oldestDate) e.oldestDate = d;
        if (d > e.newestDate) {
          e.newestDate = d;
          e.newestMessageId = msg.id;
        }
        if (e.sampleSubjects.length < 3 && msg.subject) e.sampleSubjects.push(msg.subject);

        processed++;
      }

      maybeSendProgress();

      if (!page.id) break;

      if (scan.cancelled) {
        sendScanMessage({
          type: "scan-cancelled",
          scanId: effectiveScanId,
          processed,
          total: Math.max(total, processed),
        });
        return { cancelled: true };
      }

      page = await browser.messages.continueList(page.id);
    }

    const now = new Date();
    for (const e of Object.values(senders)) {
      e._msgDates.sort((a, b) => b.t - a.t);
      e.messageIds = e._msgDates.map(m => m.id);
      delete e._msgDates;
      e.riskScore = computeRiskScore(e, now);

      const bulk = computeBulkScore(e.email, e.displayName, e.sampleSubjects);
      e.bulkScore = bulk.bulkScore;
      e.isBulkCandidate = bulk.isBulkCandidate;
      e.bulkReasons = bulk.bulkReasons;
    }

    const resultSenders = Object.values(senders);
      
    maybeSendProgress(true);

    sendScanMessage({
      type: "scan-complete",
      scanId: effectiveScanId,
      profile: options.profile || "full",
      senders: resultSenders,
    });

    return {
      started: true,
      completed: true,
      profile: options.profile || "full",
      senders: resultSenders,
    };
  } finally {
    activeScans.delete(effectiveScanId);
  }
}

// ─── Protected storage ────────────────────────────────────────────────────────
async function loadProtected() {
  const data = await browser.storage.local.get(["protectedFolderIds", "protectedEmails"]);
  return {
    protectedFolderIds: data.protectedFolderIds || [],
    protectedEmails:    data.protectedEmails    || [],
  };
}

async function saveProtected(protectedFolderIds, protectedEmails) {
  await browser.storage.local.set({ protectedFolderIds, protectedEmails });
}

async function handleToggleProtect(identifier, protect, kind) {
  const { protectedFolderIds, protectedEmails } = await loadProtected();

  if (kind === "folder") {
    const updated = protect
      ? [...new Set([...protectedFolderIds, identifier])]
      : protectedFolderIds.filter(id => id !== identifier);
    await saveProtected(updated, protectedEmails);
    return { success: true, protectedFolderIds: updated, protectedEmails };
  }

  const updated = protect
    ? [...new Set([...protectedEmails, identifier])]
    : protectedEmails.filter(e => e !== identifier);
  await saveProtected(protectedFolderIds, updated);
  return { success: true, protectedFolderIds, protectedEmails: updated };
}

async function handleSetProtectedEmails(emails) {
  const normalizedEmails = [...new Set(
    (emails || [])
      .map(email => String(email || "").trim().toLowerCase())
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));

  const { protectedFolderIds } = await loadProtected();

  await saveProtected(protectedFolderIds, normalizedEmails);

  return {
    success: true,
    protectedFolderIds,
    protectedEmails: normalizedEmails,
  };
}

async function handleProtectEmails(emails, protect = true) {
  const normalizedEmails = [...new Set(
    (emails || [])
      .map(email => String(email || "").trim().toLowerCase())
      .filter(Boolean)
  )];

  if (normalizedEmails.length === 0) {
    return { error: "Keine Absender zum Schützen angegeben." };
  }

  const { protectedFolderIds, protectedEmails } = await loadProtected();

  let updated;

  if (protect) {
    updated = [...new Set([...protectedEmails, ...normalizedEmails])];
  } else {
    const removeSet = new Set(normalizedEmails);
    updated = protectedEmails.filter(email => !removeSet.has(email));
  }

  await saveProtected(protectedFolderIds, updated);

  return {
    success: true,
    protectedFolderIds,
    protectedEmails: updated,
    changedCount: normalizedEmails.length,
  };
}

function ageDays(dateValue, now = Date.now()) {
  const d = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (Number.isNaN(d.getTime())) return 0;
  return Math.max(0, Math.floor((now - d.getTime()) / 86400000));
}

async function mapLimit(items, limit, mapper) {
  const result = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      result[index] = await mapper(items[index], index);
    }
  }

  const workers = [];
  const count = Math.max(1, Math.min(limit, items.length));

  for (let i = 0; i < count; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return result;
}

async function readMessageBasics(messageIds) {
  const rows = await mapLimit(messageIds, 20, async id => {
    try {
      const msg = await browser.messages.get(id);
      return {
        id,
        date: msg.date ? new Date(msg.date) : new Date(0),
        size: msg.size || 0,
        subject: msg.subject || "",
      };
    } catch {
      return null;
    }
  });

  return rows.filter(Boolean);
}

async function filterMessageIdsForTrashRules(messageIds, options = {}) {
  const olderThanDays = Number.parseInt(options.olderThanDays || "0", 10);
  const keepNewest = Number.parseInt(options.keepNewest || "0", 10);
  const groups = Array.isArray(options.senderGroups) && options.senderGroups.length > 0
    ? options.senderGroups
    : [{ email: "", messageIds }];

  const useOlderThan = Number.isFinite(olderThanDays) && olderThanDays > 0;
  const useKeepNewest = Number.isFinite(keepNewest) && keepNewest > 0;

  if (!useOlderThan && !useKeepNewest) {
    return {
      messageIdsToMove: [...new Set(messageIds)],
      skippedCount: 0,
      totalInputCount: messageIds.length,
    };
  }

  const now = Date.now();
  const moveSet = new Set();
  let skippedCount = 0;
  let totalInputCount = 0;

  for (const group of groups) {
    const groupIds = Array.isArray(group.messageIds) ? group.messageIds : [];
    const basics = await readMessageBasics(groupIds);

    totalInputCount += basics.length;

    basics.sort((a, b) => b.date.getTime() - a.date.getTime());

    const keepNewestSet = new Set(
      useKeepNewest
        ? basics.slice(0, keepNewest).map(row => row.id)
        : []
    );

    for (const row of basics) {
      if (keepNewestSet.has(row.id)) {
        skippedCount++;
        continue;
      }

      if (useOlderThan && ageDays(row.date, now) < olderThanDays) {
        skippedCount++;
        continue;
      }

      moveSet.add(row.id);
    }
  }

  return {
    messageIdsToMove: [...moveSet],
    skippedCount,
    totalInputCount,
  };
}

async function handlePreviewTrash(messageIds, options = {}) {
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    return { error: "Keine Nachrichten ausgewählt." };
  }

  const filterResult = await filterMessageIdsForTrashRules(messageIds, options);
  const idsToMove = filterResult.messageIdsToMove || [];
  const basics = await readMessageBasics(idsToMove);

  const moveSizeBytes = basics.reduce((sum, row) => sum + (row.size || 0), 0);

  const sampleSubjects = basics
    .slice()
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .slice(0, 5)
    .map(row => row.subject)
    .filter(Boolean);

  return {
    success: true,
    totalInputCount: filterResult.totalInputCount ?? messageIds.length,
    moveCount: idsToMove.length,
    skippedCount: filterResult.skippedCount || 0,
    moveSizeBytes,
    sampleSubjects,
  };
}

// ─── Actions + Undo ───────────────────────────────────────────────────────────
async function handlePerformAction(type, messageIds, accountId, folderId, options) {
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    return { error: "Keine Nachrichten ausgewählt." };
  }

  switch (type) {
    case "trash": {
      const trash = await findTrashFolder(accountId);

      if (!trash) {
        const folders = await listFolderDebugNames(accountId);
        return {
          error:
            "Papierkorb-Ordner nicht gefunden. " +
            "Thunderbird hat keinen Ordner mit type=trash geliefert. " +
            "Gefundene Ordner: " +
            folders.slice(0, 30).join(" | "),
        };
      }

      const filterResult = await filterMessageIdsForTrashRules(messageIds, options);
      const idsToMove = filterResult.messageIdsToMove;

      if (idsToMove.length === 0) {
        return {
          success: true,
          undoable: false,
          movedCount: 0,
          skippedCount: filterResult.skippedCount,
          message:
            "Keine Mails erfüllen die Aufräum-Regeln. Es wurde nichts verschoben.",
        };
      }

      const { newIds, failedCount, movedCount } = await moveAndTrackIds(idsToMove, trash);

      if (movedCount === 0) {
        return {
          error:
            `Keine der ${idsToMove.length} Mails konnte in den Papierkorb '${trash.name}' ` +
            "verschoben werden — die Nachrichten-IDs sind vermutlich veraltet. " +
            "Bitte neu scannen und erneut versuchen.",
        };
      }

      await browser.storage.session.set({
        undoEntry: {
          type: "trash",
          messageIds: newIds,
          sourceFolderId: folderId,
          accountId,
        },
      });

      return {
        success: true,
        undoable: newIds.length > 0,
        movedCount,
        failedCount,
        skippedCount: filterResult.skippedCount,
        totalInputCount: filterResult.totalInputCount,
      };
    }
    

    case "delete":
      await browser.messages.delete(messageIds, { deletePermanently: true, isUserAction: true });
      await browser.storage.session.remove("undoEntry");
      break;

    case "tag": {
      const { tagKey } = options;
      if (!tagKey) return { error: "Kein tagKey angegeben." };
      for (const id of messageIds) {
        const msg = await browser.messages.get(id);
        await browser.messages.update(id, { tags: [...new Set([...(msg.tags || []), tagKey])] });
      }
      await browser.storage.session.set({
        undoEntry: { type: "tag", messageIds, tagKey, accountId },
      });
      break;
    }

    case "folder": {
      const { folderName, parentFolderId, existingFolderId } = options;
      let targetFolder;
      if (existingFolderId) {
        targetFolder = await findFolder(accountId, existingFolderId);
        if (!targetFolder) return { error: "Bestehender Ordner nicht gefunden." };
      } else {
        if (!folderName) return { error: "Kein Ordner-Name angegeben." };
        let parent;
        if (parentFolderId) {
          parent = await findFolder(accountId, parentFolderId);
        } else {
          const accounts = await browser.accounts.list(true);
          parent = accounts.find(a => a.id === accountId)?.rootFolder;
        }
        if (!parent) return { error: "Übergeordneter Ordner nicht gefunden." };
        targetFolder = await browser.folders.create(parent.id, folderName);
      }
      const { newIds, failedCount, movedCount } = await moveAndTrackIds(messageIds, targetFolder);

      if (movedCount === 0) {
        return {
          error:
            `Keine der ${messageIds.length} Mails konnte nach '${targetFolder.name}' ` +
            "verschoben werden — die Nachrichten-IDs sind vermutlich veraltet. " +
            "Bitte neu scannen und erneut versuchen.",
        };
      }

      await browser.storage.session.set({
        undoEntry: { type: "folder", messageIds: newIds, sourceFolderId: folderId, accountId },
      });

      return {
        success: true,
        undoable: newIds.length > 0,
        movedCount,
        failedCount,
      };
    }

    default:
      return { error: "Unbekannte Aktion: " + type };
  }

  return { success: true, undoable: type !== "delete" };
}

async function handleUndo() {
  const { undoEntry } = await browser.storage.session.get("undoEntry");
  if (!undoEntry) return { error: "Nichts zum Rückgängigmachen." };

  if (undoEntry.type === "trash" || undoEntry.type === "folder") {
    const source = await findFolder(undoEntry.accountId, undoEntry.sourceFolderId);
    if (!source) return { error: "Quell-Ordner nicht gefunden." };
    await browser.messages.move(undoEntry.messageIds, source.id, { isUserAction: true });
  } else if (undoEntry.type === "tag") {
    for (const id of undoEntry.messageIds) {
      const msg = await browser.messages.get(id);
      await browser.messages.update(id, {
        tags: (msg.tags || []).filter(t => t !== undoEntry.tagKey),
      });
    }
  }

  await browser.storage.session.remove("undoEntry");
  return { success: true };
}

// ─── Unsubscribe ──────────────────────────────────────────────────────────────
function getHeaderValue(headers, headerName) {
  if (!headers || !headerName) return "";

  const wanted = headerName.toLowerCase();

  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() !== wanted) continue;

    if (Array.isArray(value)) return value[0] || "";
    return String(value || "");
  }

  return "";
}

function parseListUnsubscribeHeader(raw) {
  if (!raw) return { kind: "none" };

  const mailtoMatch = raw.match(/<mailto:([^>?]+)(?:\?([^>]*))?>/i);
  if (mailtoMatch) {
    const params = new URLSearchParams(mailtoMatch[2] || "");
    return {
      kind: "mailto",
      address: decodeURIComponent(mailtoMatch[1]),
      subject: params.get("subject") || "Unsubscribe",
    };
  }

  const httpsMatch = raw.match(/<(https?:\/\/[^>]+)>/i);
  if (httpsMatch) {
    return {
      kind: "https",
      url: httpsMatch[1],
    };
  }

  return { kind: "none" };
}

async function getUnsubscribeInfoFromMessage(messageId) {
  if (!messageId) return { kind: "none" };

  let full;
  try {
    full = await browser.messages.getFull(messageId);
  } catch {
    return { kind: "none" };
  }

  const headers = full.headers || {};
  const raw = getHeaderValue(headers, "list-unsubscribe");
  const info = parseListUnsubscribeHeader(raw);

  return {
    ...info,
    messageId,
    hasUnsubscribe: info.kind !== "none",
  };
}

async function handleGetUnsubscribeInfo(messageId) {
  return getUnsubscribeInfoFromMessage(messageId);
}

async function checkOneSenderUnsubscribe(group, limitPerSender) {
  const email = group?.email || "";
  const ids = Array.isArray(group?.messageIds) ? group.messageIds : [];

  const uniqueIds = [...new Set(ids)].slice(0, Math.max(1, limitPerSender));

  for (const messageId of uniqueIds) {
    const info = await getUnsubscribeInfoFromMessage(messageId);

    if (info.kind !== "none") {
      return {
        email,
        found: true,
        info,
      };
    }
  }

  return {
    email,
    found: false,
    info: { kind: "none" },
  };
}

async function handleCheckUnsubscribeForSenders(senderGroups, limitPerSender = 3) {
  if (!Array.isArray(senderGroups) || senderGroups.length === 0) {
    return {
      success: true,
      checked: 0,
      found: 0,
      results: [],
    };
  }

  const groups = senderGroups
    .filter(group => group?.email && Array.isArray(group.messageIds) && group.messageIds.length > 0)
    .slice(0, 500);

  const results = await mapLimit(groups, 8, group =>
    checkOneSenderUnsubscribe(group, limitPerSender)
  );

  return {
    success: true,
    checked: results.length,
    found: results.filter(r => r.found).length,
    results,
  };
}

async function handleDoCompose(to, subject) {
  // isPlainText:true requires plainTextBody (NOT body)
  await browser.compose.beginNew(null, {
    to: [to],
    subject,
    isPlainText: true,
    plainTextBody: "Please unsubscribe me from your mailing list.",
  });
  return { success: true };
}
