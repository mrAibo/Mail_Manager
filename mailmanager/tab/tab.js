// MailManager — Tab UI (source of truth for sender data)
const _ = (key, subs) => browser.i18n?.getMessage?.(key, subs) || key;
import { formatSize, formatRelativeDate, toCSV, toJSON } from "../shared/utils.js";
import { extractPreviewText } from "../shared/message-preview.mjs";
import { escapeHtml, daysSince, cleanupScoreTooltip, matchesAdvancedFilter, isTextEntryTarget, isCurrentScanMessage, canConfirmTrash, isCurrentPreviewRequest } from "./tab-utilities.js";

function emptyAdvancedFilter() {
  return {
    sizeMinMB: null,
    sizeMaxMB: null,
    lastMailDaysMin: null,
    lastMailDaysMax: null,
    readStatus: "all",
  };
}

const state = {
  accounts:           [],
  protectedEmails:    new Set(),
  protectedFolderIds: new Set(),
  allSenders:         [],   // full SenderEntry[] from last scan — the source of truth
  viewMode:           "senders", // "senders" or "domains"
  expandedDomains:    new Set(),
  expandedSenders:    new Set(),   // E-Mails aufgeklappter Absender
  senderMessages:     new Map(),   // E-Mail → { ids, metas, total, loadedCount }
  expandedPreviews:   new Set(),   // Mail-IDs mit offener Vorschau
  messagePreviews:    new Map(),   // Mail-ID → Vorschautext
  messageAttachments: new Map(),   // Mail-ID → Anhangsliste
  attachmentDialogMeta: null,      // aktuell im Anhang-Dialog gezeigte Mail
  filteredSenders:    [],   // after text filter
  filteredDomains:    [],   // after text filter (if viewMode === "domains")
  sortKey:            "riskScore",
  sortDesc:           true,
  quickFilter:        "all",
  advancedFilter:     emptyAdvancedFilter(),  // erweiterte, kombinierbare Filterkriterien
  isCheckingUnsubscribe: false,
  selected:           new Set(),  // selected email addresses (senders)
  selectedMessages:   new Set(),  // selected message IDs (individual mails)
  detailEmail:        null,       // sender shown in the detail panel
  dragMessageIds:     null,        // message IDs being dragged (drag & drop into folder)
  undoTimer:          null,
  activeScanId:       null,
  activeScanAccountId: null,
  activeScanFolderId:  null,
  scanCancelRequested: false,
  lastSelectedEmail:   null,
  customRegexRules:    [],   // [{ pattern, title, enabled }]
};

const $ = id => document.getElementById(id);

/** Verzögert fn, bis ms ohne neuen Aufruf vergangen sind. */
function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

const CLEANUP_SCORE_HELP = _("cleanupScoreHelp");

function applyCleanupScoreLabels() {
  document.querySelectorAll(".col-risk, [data-sort='riskScore']").forEach(el => {
    el.title = CLEANUP_SCORE_HELP;
  });
}

const SCAN_CACHE_PREFIX = "mailmanager.scanCache.v2:";
const TRASH_RULE_PREF_KEY = "mailmanager.trashRules.v1";
const CUSTOM_REGEX_RULES_KEY = "mailmanager.customRegexRules.v1";
const CLEANUP_RULES_KEY = "mailmanager.cleanupRules.v1";
const ACTION_LOG_KEY = "mailmanager.actionLog.v1";
const UI_PREFS_KEY = "mailmanager.uiPrefs.v1";
const COLUMN_VISIBILITY_KEY = "mailmanager.columnVisibility.v1";
const ACTION_LOG_LIMIT = 200;

const CONFIGURABLE_COLUMNS = [
  { id: "col-sender", label: _("colSender") },
  { id: "col-count", label: _("colCount") },
  { id: "col-size", label: _("colSize") },
  { id: "col-read", label: _("colRead") },
  { id: "col-date", label: _("colDate") },
  { id: "col-risk", label: _("colRisk") },
];

const DEFAULT_COLUMN_VISIBILITY = {
  "col-sender": true,
  "col-count": true,
  "col-size": true,
  "col-read": true,
  "col-date": true,
  "col-risk": true,
};

function makeScanCacheKey(accountId, folderId) {
  if (!accountId || !folderId) return null;
  return `${SCAN_CACHE_PREFIX}${accountId}:${folderId}`;
}

function serializeSendersForCache(senders) {
  return (senders || []).map(sender => ({
    ...sender,
    oldestDate: sender.oldestDate instanceof Date
      ? sender.oldestDate.toISOString()
      : sender.oldestDate,
    newestDate: sender.newestDate instanceof Date
      ? sender.newestDate.toISOString()
      : sender.newestDate,
  }));
}

function hydrateSendersFromCache(senders) {
  return (senders || []).map(sender => ({
    ...sender,
    oldestDate: new Date(sender.oldestDate),
    newestDate: new Date(sender.newestDate),
  }));
}

async function saveScanCache(accountId, folderId, senders) {
  const key = makeScanCacheKey(accountId, folderId);
  if (!key) return;

  const payload = {
    savedAt: new Date().toISOString(),
    accountId,
    folderId,
    senders: serializeSendersForCache(senders),
  };

  try {
    await browser.storage.session.set({ [key]: payload });
  } catch (err) {
    console.warn("MailManager: Scan-Cache konnte nicht gespeichert werden:", err);
  }
}

async function loadScanCache(accountId, folderId) {
  const key = makeScanCacheKey(accountId, folderId);
  if (!key) return null;

  try {
    const data = await browser.storage.session.get(key);
    const entry = data?.[key];

    if (!entry || !Array.isArray(entry.senders)) return null;
    if (entry.accountId !== accountId || entry.folderId !== folderId) return null;

    return {
      ...entry,
      senders: hydrateSendersFromCache(entry.senders),
    };
  } catch (err) {
    console.warn("MailManager: Scan-Cache konnte nicht gelesen werden:", err);
    return null;
  }
}

function formatCacheAge(savedAt) {
  const d = new Date(savedAt);
  if (Number.isNaN(d.getTime())) return _("fromCacheGeneric");

  const seconds = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (seconds < 60) return _("fromCacheJustNow");

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return _("fromCacheMinutes", [minutes]);

  const hours = Math.round(minutes / 60);
  return _("fromCacheHours", [hours]);
}

function clearCurrentResults() {
  state.allSenders = [];
  state.filteredSenders = [];
  state.selected.clear();
  state.selectedMessages.clear();
  state.lastSelectedEmail = null;
  state.detailEmail = null;
  renderDetailPanel();
  state.quickFilter = "all";
  state.advancedFilter = emptyAdvancedFilter();
  state.expandedSenders.clear();
  state.senderMessages.clear();
  state.expandedPreviews.clear();
  state.messagePreviews.clear();
  state.messageAttachments.clear();
  syncQuickFilterButtons();
  syncAdvancedFilterInputs();

  $("senderList").innerHTML = "";
  $("statsLabel").textContent = "";
  updateActionButtons();
  syncSelectAll();
  updateCleanupAssistant();
  updateCleanupDashboard();
  scheduleFeatureStatusUpdate();
}

async function showCachedScanForCurrentSelection() {
  if (state.activeScanId) return;

  const accountId = $("accountSelect").value;
  const folderId = $("folderSelect").value;

  clearCurrentResults();

  if (!accountId || !folderId) return;

  const cached = await loadScanCache(accountId, folderId);
  if (!cached) return;

  state.allSenders = cached.senders;
  applyFilter();
  updateStatsLabel(_("cacheLabel", [formatCacheAge(cached.savedAt)]));
  updateCleanupAssistant();
  updateCleanupDashboard();
  scheduleFeatureStatusUpdate();
}

function makeScanId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `scan-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function currentScanProfile() {
  return $("scanProfileSelect")?.value || "full";
}

function scanOptionsForProfile(profile) {
  switch (profile) {
    case "oldYear":
      return {
        profile,
        olderThanDays: 365,
      };

    case "bulk":
      return {
        profile,
        bulkOnly: true,
      };

    case "unread":
      return {
        profile,
        unreadOnly: true,
      };

    case "cleanupCandidates":
      return {
        profile,
        cleanupCandidatesOnly: true,
      };

    case "full":
    default:
      return {
        profile: "full",
      };
  }
}

function scanProfileLabel(profile) {
  switch (profile) {
    case "oldYear":
      return _("scanProfileOldYear");
    case "bulk":
      return _("scanProfileBulk");
    case "unread":
      return _("scanProfileUnread");
    case "cleanupCandidates":
      return _("scanProfileCleanup");
    case "full":
    default:
      return _("scanProfileFull");
  }
}

function ensureCancelScanButton() {
  if ($("cancelScanBtn")) return;

  const scanBtn = $("scanBtn");
  if (!scanBtn) return;

  const btn = document.createElement("button");
  btn.id = "cancelScanBtn";
  btn.type = "button";
  btn.textContent = _("cancelScanBtn");
  btn.hidden = true;
  btn.style.marginLeft = "0.5rem";
  scanBtn.insertAdjacentElement("afterend", btn);
}


let featureStatusUpdateTimer = null;

function ensureFeatureStatusBar() {
  const footer = $("sidebarFooter");
  if (!footer) return;
  if ($("featureStatusBar")) return;

  const bar = document.createElement("div");
  bar.id = "featureStatusBar";
  bar.innerHTML = `
    <span class="feature-status-chip" id="statusView">${_("featureStatus_view")}</span>
    <span class="feature-status-chip" id="statusProfile">${_("featureStatus_profile")}</span>
    <span class="feature-status-chip" id="statusCache">${_("featureStatus_cache")}</span>
    <span class="feature-status-chip" id="statusRules">${_("featureStatus_rules")}</span>
    <span class="feature-status-chip" id="statusProtected">${_("featureStatus_protected")}</span>
    <span class="feature-status-chip" id="statusLog">${_("featureStatus_log")}</span>
    <span class="feature-status-chip" id="statusSelection">${_("featureStatus_selection")}</span>
  `;

  footer.insertBefore(bar, footer.firstChild);
}

function setFeatureStatusText(id, text, tone = "") {
  const el = $(id);
  if (!el) return;

  el.textContent = text;
  el.dataset.tone = tone;
}

async function countCleanupRulesForStatus() {
  if (typeof loadCleanupRules !== "function") return null;

  try {
    const rules = await loadCleanupRules();
    return rules && typeof rules === "object" ? Object.keys(rules).length : 0;
  } catch {
    return null;
  }
}

async function countActionLogForStatus() {
  if (typeof loadActionLog !== "function") return null;

  try {
    const entries = await loadActionLog();
    return Array.isArray(entries) ? entries.length : 0;
  } catch {
    return null;
  }
}

async function scanCacheStatusForCurrentSelection() {
  if (typeof loadScanCache !== "function") return { text: _("statusUnknown"), state: "unknown" };

  const accountId = $("accountSelect")?.value || "";
  const folderId = $("folderSelect")?.value || "";

  if (!accountId || !folderId) return { text: _("statusNoFolder"), state: "empty" };

  try {
    const cached = await loadScanCache(accountId, folderId);
    if (!cached) return { text: _("statusEmpty"), state: "empty" };

    if (typeof formatCacheAge === "function") {
      return { text: formatCacheAge(cached.savedAt), state: "available" };
    }

    return { text: _("statusAvailable"), state: "available" };
  } catch {
    return { text: _("statusError"), state: "error" };
  }
}

function currentViewLabelForStatus() {
  switch (state.viewMode) {
    case "domains":
      return _("viewDomains");
    case "senders":
    default:
      return _("viewSenders");
  }
}

function currentScanProfileLabelForStatus() {
  if (typeof currentScanProfile !== "function") return _("scanProfileFull");

  const profile = currentScanProfile();

  if (typeof scanProfileLabel === "function") {
    return scanProfileLabel(profile);
  }

  return profile || _("scanProfileFull");
}

async function updateFeatureStatusBar() {
  ensureFeatureStatusBar();

  const rulesCount = await countCleanupRulesForStatus();
  const logCount = await countActionLogForStatus();
  const cacheStatus = await scanCacheStatusForCurrentSelection();

  const selectedCount = state.selected?.size || 0;
  const senderCount = state.allSenders?.length || 0;
  const filteredCount = state.filteredSenders?.length || 0;
  const domainCount = state.filteredDomains?.length || 0;
  const protectedCount = state.protectedEmails?.size || 0;

  setFeatureStatusText("statusView",
    _("featureStatus_viewValue", [
      `${currentViewLabelForStatus()}${state.viewMode === "domains" ? ` · ${_("featureStatus_domains", [String(domainCount)])}` : ""}`,
    ])
  );

  setFeatureStatusText("statusProfile",
    _("featureStatus_profileValue", [currentScanProfileLabelForStatus()])
  );

  setFeatureStatusText("statusCache",
    _("featureStatus_cacheValue", [cacheStatus.text]),
    cacheStatus.state === "empty" ? "muted" : "ok"
  );

  setFeatureStatusText("statusRules",
    _("featureStatus_rulesValue", [String(rulesCount === null ? "–" : rulesCount)]),
    rulesCount > 0 ? "ok" : "muted"
  );

  setFeatureStatusText("statusProtected",
    _("featureStatus_protectedValue", [String(protectedCount)]),
    protectedCount > 0 ? "ok" : "muted"
  );

  setFeatureStatusText("statusLog",
    _("featureStatus_logValue", [String(logCount === null ? "–" : logCount)]),
    logCount > 0 ? "ok" : "muted"
  );

  setFeatureStatusText("statusSelection",
    _("featureStatus_selectionValue", [String(selectedCount), String(filteredCount), String(senderCount)]),
    selectedCount > 0 ? "active" : "muted"
  );
}

function scheduleFeatureStatusUpdate() {
  if (featureStatusUpdateTimer) {
    clearTimeout(featureStatusUpdateTimer);
  }

  featureStatusUpdateTimer = setTimeout(() => {
    featureStatusUpdateTimer = null;
    updateFeatureStatusBar().catch(err =>
      console.warn("MailManager: Statusleiste konnte nicht aktualisiert werden:", err)
    );
  }, 80);
}

const QUICK_FILTER_SECTIONS = [
  { label: "filter_section_view", filters: [{ key: "all", label: "filter_all" }, { key: "selected", label: "filter_selected" }] },
  { label: "filter_section_recommended", filters: [{ key: "highScore", label: "filter_high_score" }] },
  { label: "filter_section_filter", filters: [{ key: "bulk", label: "filter_bulk" }, { key: "largeSize", label: "filter_large" }, { key: "inactiveYear", label: "filter_inactive_1y" }, { key: "inactiveTwoYears", label: "filter_inactive_2y" }] },
  { label: "filter_section_unsubscribe", filters: [{ key: "unsubscribe", label: "filter_unsubscribable" }] },
];

function ensureQuickFilterBar() {
  const target = $("filterSection");
  if (!target || $("quickFilterBar")) return;

  const bar = document.createElement("div");
  bar.id = "quickFilterBar";

  for (const section of QUICK_FILTER_SECTIONS) {
    const label = document.createElement("div");
    label.className = "quick-filter-section-label";
    label.textContent = _(section.label);
    bar.appendChild(label);

    const row = document.createElement("div");
    row.className = "quick-filter-row";
    for (const filter of section.filters) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "quick-filter-btn";
      btn.dataset.filter = filter.key;
      btn.textContent = filter.label.startsWith("filter_") ? _(filter.label) : filter.label;
      btn.addEventListener("click", () => {
        state.quickFilter = filter.key;
        syncQuickFilterButtons();
        applyFilter();
      });
      row.appendChild(btn);
    }
    bar.appendChild(row);
  }

  const actions = document.createElement("div");
  actions.className = "quick-filter-actions";
  const checkBtn = document.createElement("button");
  checkBtn.id = "checkUnsubBtn";
  checkBtn.type = "button";
  checkBtn.className = "filter-action-btn check-unsub-btn";
  checkBtn.innerHTML = `${icon("search")} ${_("quickFilter_unsubscribe_check", "Check Unsubscribe Links")}`;
  checkBtn.title =
    "Prüft List-Unsubscribe-Header nur für ausgewählte oder sichtbare Kandidaten. " +
    "Der normale Scan bleibt dadurch schnell.";
  checkBtn.addEventListener("click", handleCheckUnsubscribeCandidates);
  actions.appendChild(checkBtn);

  // Bulk unsubscribe button — appears after check when senders have unsubscribe links
  const bulkBtn = document.createElement("button");
  bulkBtn.id = "bulkUnsubBtn";
  bulkBtn.type = "button";
  bulkBtn.className = "filter-action-btn filter-action-btn-secondary bulk-unsub-btn";
  bulkBtn.style.display = "none";
  bulkBtn.addEventListener("click", handleBulkUnsubscribe);
  actions.appendChild(bulkBtn);
  bar.appendChild(actions);

  target.appendChild(bar);
  syncQuickFilterButtons();
}

function syncQuickFilterButtons() {
  document.querySelectorAll(".quick-filter-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.filter === state.quickFilter);
  });
}

// ─── Erweiterte Filter (konfigurierbares Panel) ───────────────────────────────
function advancedFilterActive() {
  const f = state.advancedFilter;
  return f.sizeMinMB != null || f.sizeMaxMB != null ||
    f.lastMailDaysMin != null || f.lastMailDaysMax != null ||
    f.readStatus !== "all";
}

/** Baut das aufklappbare Panel für erweiterte Filter in die Sidebar ein. */
function ensureAdvancedFilterPanel() {
  const target = $("filterSection");
  if (!target) return;
  if ($("advancedFilterPanel")) return;

  const panel = document.createElement("details");
  panel.id = "advancedFilterPanel";
  panel.innerHTML = `
    <summary>${_("advancedFilter_title")}</summary>
    <div class="advanced-filter-body">
      <div class="advanced-filter-row">
        <span class="advanced-filter-label">${_("advancedFilter_size")}</span>
        <input type="number" id="advFilterSizeMin" min="0" step="1" placeholder="${_("advancedFilter_from")}" />
        <input type="number" id="advFilterSizeMax" min="0" step="1" placeholder="${_("advancedFilter_to")}" />
      </div>
      <div class="advanced-filter-row">
        <span class="advanced-filter-label">${_("advancedFilter_lastMailDays")}</span>
        <input type="number" id="advFilterDaysMin" min="0" step="1" placeholder="min." />
        <input type="number" id="advFilterDaysMax" min="0" step="1" placeholder="max." />
      </div>
      <label class="advanced-filter-field" for="advFilterReadStatus">${_("advancedFilter_readStatus")}
        <select id="advFilterReadStatus">
          <option value="all">${_("advancedFilter_all")}</option>
          <option value="read">${_("advancedFilter_read")}</option>
          <option value="unread">${_("advancedFilter_unread")}</option>
        </select>
      </label>
      <button type="button" id="advFilterReset">${_("advancedFilter_reset")}</button>
    </div>
  `;

  target.appendChild(panel);

  for (const id of ["advFilterSizeMin", "advFilterSizeMax", "advFilterDaysMin", "advFilterDaysMax"]) {
    $(id).addEventListener("input", onAdvancedFilterChanged);
  }
  $("advFilterReadStatus").addEventListener("change", onAdvancedFilterChanged);
  $("advFilterReset").addEventListener("click", resetAdvancedFilter);

  syncAdvancedFilterInputs();
}

/** Liest einen nicht-negativen Zahlenwert aus einem Eingabefeld; leer → null. */
function readAdvancedFilterNumber(id) {
  const value = Number.parseFloat($(id)?.value);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function onAdvancedFilterChanged() {
  state.advancedFilter = {
    sizeMinMB:       readAdvancedFilterNumber("advFilterSizeMin"),
    sizeMaxMB:       readAdvancedFilterNumber("advFilterSizeMax"),
    lastMailDaysMin: readAdvancedFilterNumber("advFilterDaysMin"),
    lastMailDaysMax: readAdvancedFilterNumber("advFilterDaysMax"),
    readStatus:      $("advFilterReadStatus")?.value || "all",
  };

  syncAdvancedFilterActiveIndicator();
  applyFilter();
}

function resetAdvancedFilter() {
  state.advancedFilter = emptyAdvancedFilter();
  syncAdvancedFilterInputs();
  applyFilter();
}

/** Überträgt state.advancedFilter zurück in die Eingabefelder. */
function syncAdvancedFilterInputs() {
  const f = state.advancedFilter;
  const set = (id, value) => { if ($(id)) $(id).value = value ?? ""; };

  set("advFilterSizeMin", f.sizeMinMB);
  set("advFilterSizeMax", f.sizeMaxMB);
  set("advFilterDaysMin", f.lastMailDaysMin);
  set("advFilterDaysMax", f.lastMailDaysMax);
  if ($("advFilterReadStatus")) $("advFilterReadStatus").value = f.readStatus;

  syncAdvancedFilterActiveIndicator();
}

function syncAdvancedFilterActiveIndicator() {
  const panel = $("advancedFilterPanel");
  if (panel) panel.classList.toggle("has-active-filter", advancedFilterActive());
}

function isInactiveForDays(dateValue, days) {
  const d = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (Number.isNaN(d.getTime())) return false;
  return Date.now() - d.getTime() >= days * 86400000;
}

function unreadRate(sender) {
  if (!sender || sender.count <= 0) return 0;
  return (sender.count - sender.readCount) / sender.count;
}

function matchesQuickFilter(sender) {
  switch (state.quickFilter) {
    case "all":
      return true;

    case "highScore":
      return sender.riskScore >= 70;

    case "manyMails":
      return sender.count >= 100;

    case "largeSize":
      return sender.totalSizeBytes >= 100 * 1024 * 1024;

    case "inactiveYear":
      return isInactiveForDays(sender.newestDate, 365);

    case "inactiveTwoYears":
      return isInactiveForDays(sender.newestDate, 730);

    case "recentMonth": {
      const age = daysSince(sender.newestDate);
      return age !== null && age <= 30;
    }

    case "unreadHigh":
      return unreadRate(sender) >= 0.5;

    case "bulk":
      return Boolean(sender.isBulkCandidate);

    case "unsubscribe":
      return sender.hasUnsubscribe === true;

    case "protectCandidates":
      return isProtectionCandidate(sender);

    case "selected":
      return state.selected.has(sender.email);

    default:
      return true;
  }
}

function ensureCleanupAssistant() {
  const target = $("cleanupSectionBody");
  if (!target) return;
  if ($("cleanupAssistant")) return;

  const box = document.createElement("div");
  box.id = "cleanupAssistant";
  box.innerHTML = `
    <div class="assistant-title">${_("cleanupAssistant_title")}</div>
    <div id="assistantCards" class="assistant-cards"></div>
  `;

  target.appendChild(box);
}

function ensureCleanupDashboard() {
  if ($("cleanupDashboard")) return;

  const mainTopbar = $("mainTopbar");
  const quickFilterBar = $("quickFilterBar");
  const actionbar = $("mainActionbar") || $("actionbar");

  const anchor = mainTopbar || quickFilterBar || actionbar;
  if (!anchor) return;

  const dashboard = document.createElement("div");
  dashboard.id = "cleanupDashboard";
  dashboard.hidden = true;
  dashboard.innerHTML = `
    <div class="cleanup-dashboard-title">${_("dashboard_title")}</div>
    <div class="dashboard-card" data-dashboard-filter="bulk">
      <div class="dashboard-label">${_("cleanupAssistantBulkTitle")}</div>
      <div class="dashboard-value" id="dashBulk">0</div>
      <button type="button" class="dashboard-action" data-dashboard-action="bulk">${_("dashboard_view")}</button>
      <button type="button" class="dashboard-select" data-dashboard-select="bulk">${_("dashboard_select_all")}</button>
    </div>

    <div class="dashboard-card" data-dashboard-filter="largeSize">
      <div class="dashboard-label">${_("cleanupAssistantStorageTitle")}</div>
      <div class="dashboard-value" id="dashLarge">0</div>
      <button type="button" class="dashboard-action" data-dashboard-action="largeSize">${_("dashboard_view")}</button>
      <button type="button" class="dashboard-select" data-dashboard-select="largeSize">${_("dashboard_select_all")}</button>
    </div>

    <div class="dashboard-card" data-dashboard-filter="inactiveTwoYears">
      <div class="dashboard-label">${_("dashboardInactiveTwoYears")}</div>
      <div class="dashboard-value" id="dashInactive">0</div>
      <button type="button" class="dashboard-action" data-dashboard-action="inactiveTwoYears">${_("dashboard_view")}</button>
      <button type="button" class="dashboard-select" data-dashboard-select="inactiveTwoYears">${_("dashboard_select_all")}</button>
    </div>
  `;

  anchor.insertAdjacentElement("afterend", dashboard);

  dashboard.querySelectorAll(".dashboard-card[data-dashboard-filter]").forEach(card => {
    card.addEventListener("click", event => {
      if (event.target.closest("button")) return;

      const filter = card.dataset.dashboardFilter;
      if (!filter) return;

      state.quickFilter = filter;
      syncQuickFilterButtons();
      applyFilter();
    });
  });

  dashboard.querySelectorAll(".dashboard-action").forEach(button => {
    button.addEventListener("click", async event => {
      event.stopPropagation();

      const action = button.dataset.dashboardAction;

      if (action === "prepare") {
        await prepareCleanupActionForMatchingSenders(isDashboardCleanupCandidate);
        return;
      }

      const predicate = dashboardPredicate(action);
      if (!predicate) return;

      state.quickFilter = action;
      syncQuickFilterButtons();
      applyFilter();
    });
  });

  dashboard.querySelectorAll(".dashboard-select").forEach(button => {
    button.addEventListener("click", event => {
      event.stopPropagation();
      const predicate = dashboardPredicate(button.dataset.dashboardSelect);
      if (predicate) selectMatchingSenders(predicate);
    });
  });
}

function dashboardPredicate(key) {
  switch (key) {
    case "highScore":
      return sender => (sender.riskScore || 0) >= 70;

    case "bulk":
      return sender => Boolean(sender.isBulkCandidate);

    case "largeSize":
      return sender => (sender.totalSizeBytes || 0) >= 100 * 1024 * 1024;

    case "inactiveTwoYears":
      return sender => isInactiveForDays(sender.newestDate, 730);

    default:
      return null;
  }
}

function isDashboardCleanupCandidate(sender) {
  if (!sender) return false;
  if (state.protectedEmails.has(sender.email)) return false;

  return (
    (sender.riskScore || 0) >= 70 ||
    Boolean(sender.isBulkCandidate) ||
    (sender.totalSizeBytes || 0) >= 100 * 1024 * 1024 ||
    isInactiveForDays(sender.newestDate, 365)
  );
}

function dashboardStatsFor(predicate) {
  const senders = state.allSenders.filter(predicate);
  const mails = senders.reduce((sum, sender) => sum + (sender.count || 0), 0);
  const bytes = senders.reduce((sum, sender) => sum + (sender.totalSizeBytes || 0), 0);

  return {
    senders,
    senderCount: senders.length,
    mailCount: mails,
    bytes,
  };
}

function setDashboardValue(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function updateCleanupDashboard() {
  ensureCleanupDashboard();

  const dashboard = $("cleanupDashboard");
  if (dashboard) dashboard.hidden = state.allSenders.length === 0;

  if (!state.allSenders.length) {
    setDashboardValue("dashBulk", "0");
    setDashboardValue("dashLarge", "0");
    setDashboardValue("dashInactive", "0");
    return;
  }

  const bulk     = dashboardStatsFor(sender => Boolean(sender.isBulkCandidate));
  const large    = dashboardStatsFor(sender => (sender.totalSizeBytes || 0) >= 100 * 1024 * 1024);
  const inactive = dashboardStatsFor(sender => isInactiveForDays(sender.newestDate, 730));

  setDashboardValue("dashBulk",     _("senderMailCount", [bulk.senderCount, bulk.mailCount]));
  setDashboardValue("dashLarge",    `${large.senderCount} · ${formatSize(large.bytes)}`);
  setDashboardValue("dashInactive", _("senderMailCount", [inactive.senderCount, inactive.mailCount]));
}

function senderStatsFor(predicate) {
  const senders = state.allSenders.filter(predicate);
  const mails = senders.reduce((n, s) => n + s.count, 0);
  const bytes = senders.reduce((n, s) => n + s.totalSizeBytes, 0);

  return {
    senders,
    senderCount: senders.length,
    mailCount: mails,
    bytes,
  };
}

function selectMatchingSenders(predicate) {
  state.selected.clear();

  for (const sender of state.allSenders) {
    if (state.protectedEmails.has(sender.email)) continue;
    if (predicate(sender)) {
      state.selected.add(sender.email);
    }
  }

  state.quickFilter = "selected";
  syncQuickFilterButtons();
  applyFilter();
  updateSelectionLabel();
  updateActionButtons();
}

async function prepareCleanupActionForMatchingSenders(predicate) {
  selectMatchingSenders(predicate);

  if (state.selected.size === 0) {
    showError(_("errorNoMatchingSenders"));
    return;
  }

  await openConfirmDialog("trash");
}

async function protectMatchingSenders(predicate) {
  const emails = state.allSenders
    .filter(sender => predicate(sender))
    .filter(sender => !state.protectedEmails.has(sender.email))
    .map(sender => sender.email);

  if (emails.length === 0) {
    showError(_("errorNoNewProtectionCandidates"));
    return;
  }

  const ok = confirm(_("confirmProtectSenders", [String(emails.length)]));
  if (!ok) return;

  let response;
  try {
    response = await browser.runtime.sendMessage({
      action: "protectEmails",
      emails,
      protect: true,
    });
  } catch (err) {
    showError(_("errorActionFailed", [err.message || "Verbindungsfehler"]));
    return;
  }

  if (response?.error) {
    showError(response.error);
    return;
  }

  state.protectedEmails = new Set(response.protectedEmails || []);

  for (const email of emails) {
    state.selected.delete(email);
  }

  applyFilter();
  updateSelectionLabel();
  updateActionButtons();
  updateCleanupAssistant();
  updateCleanupDashboard();

  $("statsLabel").textContent =
    _("protectedSendersSuccess", [String(emails.length)]);
}

function cleanupAssistantCard({ key, title, description, stats, actionLabel, prepareLabel }) {
  const disabled = stats.senderCount === 0 ? "disabled" : "";

  return `
    <div class="assistant-card">
      <div class="assistant-card-title">${escapeHtml(title)}</div>
      <div class="assistant-card-main">
        ${_("assistantStats", [stats.senderCount, stats.mailCount, formatSize(stats.bytes)])}
      </div>
      <div class="assistant-card-desc">${escapeHtml(description)}</div>

      <div class="assistant-card-actions">
        <button class="assistant-select-btn" data-assistant-key="${escapeHtml(key)}" ${disabled}>
          ${escapeHtml(actionLabel || _("cleanupAssistantSelect"))}
        </button>

        <button class="assistant-prepare-btn" data-assistant-key="${escapeHtml(key)}" ${disabled}>
          ${escapeHtml(prepareLabel || _("cleanupAssistantPrepare"))}
        </button>
      </div>
    </div>
  `;
}

function updateCleanupAssistant() {
  const cards = $("assistantCards");
  if (!cards) return;

  if (!state.allSenders.length) {
    cards.innerHTML = `
      <div class="assistant-empty">
${_("cleanupAssistant_empty")}
      </div>
    `;
    return;
  }

  const highScore = senderStatsFor(s => s.riskScore >= 70);
  const bulk = senderStatsFor(s => s.isBulkCandidate);
  const unsubscribe = senderStatsFor(s => s.hasUnsubscribe === true);
  const largeSize = senderStatsFor(s => s.totalSizeBytes >= 100 * 1024 * 1024);
  const inactive = senderStatsFor(s => isInactiveForDays(s.newestDate, 365));
  const unreadHigh = senderStatsFor(s => unreadRate(s) >= 0.5 && s.count >= 10);
  const protectCandidates = senderStatsFor(s => isProtectionCandidate(s));

  const definitions = [
    {
      key: "protectCandidates",
      title: _("cleanupAssistantProtectTitle"),
      description: _("cleanupAssistantProtectDescription"),
      stats: protectCandidates,
      actionLabel: _("dashboard_view"),
      prepareLabel: _("cleanupAssistantProtectAction"),
      predicate: s => isProtectionCandidate(s),
      prepareAction: protectMatchingSenders,
    },
    {
      key: "highScore",
      title: _("cleanupAssistantHighScoreTitle"),
      description: _("cleanupAssistantHighScoreDescription"),
      stats: highScore,
      actionLabel: _("cleanupAssistantSelect"),
      prepareLabel: _("cleanupAssistantPrepare"),
      predicate: s => s.riskScore >= 70,
    },
    {
      key: "unsubscribe",
      title: _("domainUnsubscribe"),
      description: _("cleanupAssistantUnsubscribeDescription"),
      stats: unsubscribe,
      actionLabel: _("cleanupAssistantSelect"),
      prepareLabel: _("cleanupAssistantUnsubscribePrepare"),
      predicate: s => s.hasUnsubscribe === true,
    },
    {
      key: "bulk",
      title: _("cleanupAssistantBulkTitle"),
      description: _("cleanupAssistantBulkDescription"),
      stats: bulk,
      actionLabel: _("cleanupAssistantSelect"),
      prepareLabel: _("cleanupAssistantBulkPrepare"),
      predicate: s => s.isBulkCandidate,
    },
    {
      key: "largeSize",
      title: _("cleanupAssistantStorageTitle"),
      description: _("cleanupAssistantStorageDescription"),
      stats: largeSize,
      actionLabel: _("cleanupAssistantSelect"),
      prepareLabel: _("cleanupAssistantStoragePrepare"),
      predicate: s => s.totalSizeBytes >= 100 * 1024 * 1024,
    },
    {
      key: "inactive",
      title: _("cleanupAssistantInactiveTitle"),
      description: _("cleanupAssistantInactiveDescription"),
      stats: inactive,
      actionLabel: _("cleanupAssistantSelect"),
      prepareLabel: _("cleanupAssistantInactivePrepare"),
      predicate: s => isInactiveForDays(s.newestDate, 365),
    },
    {
      key: "unreadHigh",
      title: _("cleanupAssistantUnreadTitle"),
      description: _("cleanupAssistantUnreadDescription"),
      stats: unreadHigh,
      actionLabel: _("cleanupAssistantSelect"),
      prepareLabel: _("cleanupAssistantUnreadPrepare"),
      predicate: s => unreadRate(s) >= 0.5 && s.count >= 10,
    },
  ];

  cards.innerHTML = definitions
    .map(def => cleanupAssistantCard(def))
    .join("");

  const definitionsByKey = new Map(definitions.map(def => [def.key, def]));

  cards.querySelectorAll(".assistant-select-btn").forEach(button => {
    button.addEventListener("click", () => {
      const def = definitionsByKey.get(button.dataset.assistantKey);
      if (!def) return;

      selectMatchingSenders(def.predicate);
    });
  });

  cards.querySelectorAll(".assistant-prepare-btn").forEach(button => {
    button.addEventListener("click", async () => {
      const def = definitionsByKey.get(button.dataset.assistantKey);
      if (!def) return;

      if (typeof def.prepareAction === "function") {
        await def.prepareAction(def.predicate);
        return;
      }

      await prepareCleanupActionForMatchingSenders(def.predicate);
    });
  });
}

function setScanUiRunning(running) {
  const cancelBtn = $("cancelScanBtn");

  $("scanBtn").disabled = running;
  $("accountSelect").disabled = running;
  $("folderSelect").disabled = running;
  if ($("scanProfileSelect")) $("scanProfileSelect").disabled = running;
  [$("welcomeAccountSelect"), $("welcomeFolderSelect")].forEach(control => {
    if (control) control.disabled = running;
  });
  document.querySelectorAll(".welcome-profile").forEach(button => { button.disabled = running; });
  if ($("welcomeScanBtn")) $("welcomeScanBtn").disabled = running;

  if (cancelBtn) {
    cancelBtn.hidden = !running;
    cancelBtn.disabled = !running || state.scanCancelRequested;
  }
}

function clearActiveScan() {
  state.activeScanId = null;
  state.activeScanAccountId = null;
  state.activeScanFolderId = null;
  state.scanCancelRequested = false;
  setScanUiRunning(false);
}

async function init() {
  browser.runtime.onMessage.addListener(onBackgroundMessage);

  state.customRegexRules = await loadCustomRegexRules();

  const columnVisibility = await loadColumnVisibility();
  applyColumnVisibility(columnVisibility);

  ensureCancelScanButton();
  ensureQuickFilterBar();
  ensureAdvancedFilterPanel();
  ensureCleanupDashboard();
  ensureFeatureStatusBar();
  ensureCleanupAssistant();
  applyCleanupScoreLabels();
  updateCleanupAssistant();
  updateCleanupDashboard();
  scheduleFeatureStatusUpdate();

  $("accountSelect").addEventListener("change", async () => {
    populateFolderDropdown();
    await showCachedScanForCurrentSelection();
    scheduleFeatureStatusUpdate();
  });

  $("folderSelect").addEventListener("change", async () => {
    await showCachedScanForCurrentSelection();
    scheduleFeatureStatusUpdate();
  });

  $("scanProfileSelect")?.addEventListener("change", scheduleFeatureStatusUpdate);
  $("scanBtn").addEventListener("click", startScan);
  $("cancelScanBtn").addEventListener("click", cancelScan);
  $("welcomeScanBtn")?.addEventListener("click", startScan);
  $("welcomeAccountSelect")?.addEventListener("change", event => {
    $("accountSelect").value = event.target.value;
    $("accountSelect").dispatchEvent(new Event("change"));
  });
  $("welcomeFolderSelect")?.addEventListener("change", event => {
    $("folderSelect").value = event.target.value;
    $("folderSelect").dispatchEvent(new Event("change"));
  });
  document.querySelectorAll(".welcome-profile").forEach(button => {
    button.addEventListener("click", () => {
      $("scanProfileSelect").value = button.dataset.profile;
      document.querySelectorAll(".welcome-profile").forEach(item => item.classList.toggle("active", item === button));
    });
  });
  $("filterInput").addEventListener("input", debounce(applyFilter, 150));
  $("selectAll").addEventListener("change", toggleSelectAll);

  document.querySelectorAll(".view-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      state.viewMode = btn.dataset.view;
      syncViewSwitcherButtons();
      applyFilter();
    });
  });

  $("sortSelect").addEventListener("change", e => setSort(e.target.value));

  for (const th of document.querySelectorAll("#tableHeader [data-sort]")) {
    th.addEventListener("click", () => setSort(th.dataset.sort));
  }

  $("trashBtn").addEventListener("click", () => openConfirmDialog("trash"));
  bindTrashSafetyConfirm();
  $("saveCleanupRuleBtn")?.addEventListener("click", saveCleanupRuleForCurrentSelection);
  $("applySavedCleanupRuleBtn")?.addEventListener("click", applyCleanupRuleForCurrentSelection);
  bindTrashRulePresets();
  document.addEventListener("keydown", handleKeyboardShortcuts);
  $("folderBtn").addEventListener("click", openFolderDialog);
  $("readBtn").addEventListener("click", () => dispatchAction("markAsRead"));
  $("archiveBtn").addEventListener("click", () => dispatchAction("archive"));
  $("tagBtn").addEventListener("click", openTagDialog);
  $("unsubBtn").addEventListener("click", handleUnsubscribe);
  $("exportBtn").addEventListener("click", () => $("exportDialog").showModal());
  $("attachmentClose").addEventListener("click", () => $("attachmentDialog").close());
  $("attachmentSaveAll").addEventListener("click", () => {
    if (state.attachmentDialogMeta) saveAllAttachments(state.attachmentDialogMeta);
  });
  $("logBtn").addEventListener("click", openActionLogDialog);
  $("shortcutsBtn").addEventListener("click", () => $("shortcutsDialog").showModal());
  $("shortcutsClose").addEventListener("click", () => $("shortcutsDialog").close());
  $("columnBtn").addEventListener("click", async () => {
    await initializeColumnDialog();
    $("columnDialog").showModal();
  });
  $("columnClose").addEventListener("click", () => $("columnDialog").close());
  $("columnReset").addEventListener("click", resetColumnVisibility);
  $("ruleManagerBtn")?.addEventListener("click", openCleanupRuleManagerDialog);
  $("actionLogClose").addEventListener("click", () => $("actionLogDialog").close());
  $("cleanupRuleManagerClose")?.addEventListener("click", () => $("cleanupRuleManagerDialog").close());
  $("actionLogExport").addEventListener("click", exportActionLog);
  $("cleanupRuleImport")?.addEventListener("click", () => {
    $("cleanupRuleImportFile")?.click();
  });
  $("cleanupRuleImportFile")?.addEventListener("change", importCleanupRulesFromFile);
  $("cleanupRuleExport")?.addEventListener("click", exportCleanupRules);
  $("actionLogClear").addEventListener("click", clearActionLogWithConfirm);
  $("cleanupRuleClear")?.addEventListener("click", clearCleanupRulesWithConfirm);
  ensureTrashRuleSuggestionBox();
  $("exportCSV").addEventListener("click", () => handleExport("csv"));
  $("exportJSON").addEventListener("click", () => handleExport("json"));
  $("exportCancel").addEventListener("click", () => $("exportDialog").close());
  $("undoBtn").addEventListener("click", handleUndo);
  
  $("protectManagerBtn")?.addEventListener("click", openProtectManagerDialog);
  $("protectManagerClose")?.addEventListener("click", () => $("protectManagerDialog").close());
  $("protectManagerFilter")?.addEventListener("input", renderProtectManager);
  $("protectExport")?.addEventListener("click", exportProtectedEmails);

  $("customRegexBtn")?.addEventListener("click", () => {
    renderCustomRegexList();
    $("customRegexDialog").showModal();
  });
  $("customRegexClose")?.addEventListener("click", () => $("customRegexDialog").close());
  $("customRegexAddBtn")?.addEventListener("click", () => {
    const pattern = $("customRegexPattern").value.trim();
    const title = $("customRegexTitle").value.trim();
    if (!pattern) return;
    addCustomRegexRule(pattern, title);
    $("customRegexPattern").value = "";
    $("customRegexTitle").value = "";
  });
  $("protectImport")?.addEventListener("click", () => $("protectImportFile")?.click());
  $("protectImportFile")?.addEventListener("change", importProtectedEmailsFromFile);
  $("protectClear")?.addEventListener("click", clearProtectedEmailsWithConfirm);

  $("diagnosticsBtn")?.addEventListener("click", openDiagnosticsDialog);
  $("diagnosticsRefresh")?.addEventListener("click", refreshDiagnosticsDialog);
  $("diagnosticsCopy")?.addEventListener("click", copyDiagnosticsToClipboard);
  $("diagnosticsClose")?.addEventListener("click", () => $("diagnosticsDialog").close());

  // Quick actions
  $("quickEmptySpamBtn")?.addEventListener("click", quickEmptyFolder);

  $("senderList").addEventListener("contextmenu", e => {
    const messageRow = e.target.closest(".message-row");
    if (messageRow) {
      e.preventDefault();
      const id = Number(messageRow.dataset.messageId);
      const senderEmail = messageRow.dataset.senderEmail;
      const bucket = state.senderMessages.get(senderEmail);
      const meta = bucket?.metas.find(m => m.id === id);
      if (meta) showRowContextMenu(e.clientX, e.clientY, messageContextItems(meta));
      return;
    }
    const senderRow = e.target.closest(".sender-row");
    if (senderRow) {
      e.preventDefault();
      const entry = state.allSenders.find(s => s.email === senderRow.dataset.email);
      if (entry) showRowContextMenu(e.clientX, e.clientY, senderContextItems(entry));
    }
  });

  $("senderList").addEventListener("change", e => {
    if (e.target.classList.contains("message-checkbox")) {
      const messageId = e.target.value;
      toggleMessageSelection(messageId);

      const row = e.target.closest(".message-row");
      if (row) {
        const selected = isMessageSelected(messageId);
        row.classList.toggle("selected", selected);
        row.setAttribute("aria-selected", selected ? "true" : "false");
      }

      updateSelectionLabel();
      updateActionButtons();
    }
  });

  $("senderList").addEventListener("focusin", e => {
    const row = e.target.closest(ROW_SELECTOR);
    if (row) setActiveRow(row);
  });

  $("senderList").addEventListener("dragstart", onRowDragStart);
  $("senderList").addEventListener("dragend", onRowDragEnd);

  const dropOverlay = $("dropFolderOverlay");
  dropOverlay.addEventListener("dragover", onDropOverlayDragOver);
  dropOverlay.addEventListener("dragleave", onDropOverlayDragLeave);
  dropOverlay.addEventListener("drop", onDropOverlayDrop);

  document.addEventListener("click", e => {
    if (!e.target.closest("#rowContextMenu")) closeRowContextMenu();
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") closeRowContextMenu();
  });
  window.addEventListener("blur", closeRowContextMenu);

  const uiPrefs = await loadUiPrefs();
  if (uiPrefs.sidebarCollapsed) $("sidebar").classList.add("collapsed");

  $("sidebarToggle").addEventListener("click", () => {
    const collapsed = $("sidebar").classList.toggle("collapsed");
    saveUiPrefs({ sidebarCollapsed: collapsed });
  });

  try {
    const response = await browser.runtime.sendMessage({ action: "getAccounts" });

    if (!response) {
      throw new Error(_("accountsNoResponse"));
    }

    if (response.error) {
      throw new Error(response.error);
    }

    state.accounts = response.accounts || [];
    state.protectedEmails = new Set(response.protectedEmails || []);
    state.protectedFolderIds = new Set(response.protectedFolderIds || []);

    populateAccountDropdown();

    if (typeof migrateCleanupRulesToNormalizedDomains === "function") {
      await migrateCleanupRulesToNormalizedDomains();
    }

    await showCachedScanForCurrentSelection();
  } catch (err) {
    showError(_("initializationFailed", [err.message]));
  }
}

function populateAccountDropdown() {
  const sel = $("accountSelect");
  sel.innerHTML = "";
  for (const acc of state.accounts) {
    const opt = document.createElement("option");
    opt.value = acc.id;
    opt.textContent = acc.name;
    sel.appendChild(opt);
  }
  populateFolderDropdown();
  syncWelcomeSources();
}

function populateFolderDropdown() {
  const account = state.accounts.find(a => a.id === $("accountSelect").value);
  const sel = $("folderSelect");
  sel.innerHTML = "";

  // Virtual "all folders" entry
  const allOpt = document.createElement("option");
  allOpt.value = "__ALL__";
  allOpt.textContent = _("folderAllOption");
  sel.appendChild(allOpt);

  for (const folder of (account?.folders || [])) {
    const opt = document.createElement("option");
    opt.value = folder.id;
    opt.textContent = folder.name + (folder.protected ? " 🛡" : "");
    sel.appendChild(opt);
  }
  syncWelcomeSources();
}

function syncWelcomeSources() {
  for (const [sourceId, targetId] of [["accountSelect", "welcomeAccountSelect"], ["folderSelect", "welcomeFolderSelect"]]) {
    const source = $(sourceId), target = $(targetId);
    if (!source || !target) continue;
    target.innerHTML = source.innerHTML;
    target.value = source.value;
  }
}

function syncViewSwitcherButtons() {
  document.querySelectorAll(".view-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.view === state.viewMode);
  });
}

async function startScan() {
  const accountId = $("accountSelect").value;
  const folderId = $("folderSelect").value;
  const scanProfile = currentScanProfile();
  const scanOptions = scanOptionsForProfile(scanProfile);

  if (state.activeScanId) {
    showError(_("errorScanAlreadyRunning"));
    return;
  }

  if (!accountId) {
    showError(_("errorNoAccountSelected"));
    return;
  }

  if (!folderId) {
    showError(_("errorNoFolderSelected"));
    return;
  }

  const scanId = makeScanId();
  state.activeScanId = scanId;
  state.scanCancelRequested = false;
  state.activeScanAccountId = accountId;
  state.activeScanFolderId = folderId;

  state.allSenders = [];
  state.filteredSenders = [];
  state.selected.clear();
  state.selectedMessages.clear();
  state.quickFilter = "all";
  state.advancedFilter = emptyAdvancedFilter();
  state.lastSelectedEmail = null;
  syncQuickFilterButtons();
  syncAdvancedFilterInputs();

  $("senderList").innerHTML = "";
  $("statsLabel").textContent = "";
  updateActionButtons();

  $("progressContainer").hidden = false;
  $("progressBar").value = 0;
  $("progressLabel").textContent = _("scanProgressLabel", [scanProfileLabel(scanProfile)]);
  setScanUiRunning(true);

  try {
    const resp = await browser.runtime.sendMessage({
      action: "scan",
      accountId,
      folderId,
      scanId,
      options: scanOptions,
    });

    if (!resp) {
      throw new Error(_("scanNoResponse"));
    }

    if (resp.error) {
      throw new Error(resp.error);
    }

    if (resp.cancelled && state.activeScanId === scanId) {
      $("progressContainer").hidden = true;
      $("progressLabel").textContent = _("scanCancelledLabel");
      clearActiveScan();
      return;
    }

    if (resp.senders && state.activeScanId === scanId) {
      finishScanFromSenders(resp.senders);
      return;
    }

    if (resp.started && state.activeScanId === scanId) {
      $("progressLabel").textContent = _("scanRunningLabel");
    }
  } catch (err) {
    if (state.activeScanId === scanId) {
      $("progressContainer").hidden = true;
      clearActiveScan();
      showError(_("errorScanFailed", [err.message]));
    }
  }
}

function finishScanFromSenders(senders) {
  const accountId = state.activeScanAccountId || $("accountSelect").value;
  const folderId = state.activeScanFolderId || $("folderSelect").value;

  $("progressContainer").hidden = true;

  state.allSenders = (senders || []).map(s => ({
    ...s,
    oldestDate: new Date(s.oldestDate),
    newestDate: new Date(s.newestDate),
  }));

  saveScanCache(accountId, folderId, state.allSenders).catch(() => {});

  clearActiveScan();

  applyFilter();
  updateStatsLabel(_("scanFreshWithProfile", [scanProfileLabel(currentScanProfile())]));
  updateCleanupAssistant();
  updateCleanupDashboard();
  scheduleFeatureStatusUpdate();
}

async function cancelScan() {
  const scanId = state.activeScanId;
  if (!scanId || state.scanCancelRequested) return;

  state.scanCancelRequested = true;
  const cancelBtn = $("cancelScanBtn");
  if (cancelBtn) cancelBtn.disabled = true;
  $("progressLabel").textContent += ` — ${_("scanCancelRequested")}`;

  try {
    const resp = await browser.runtime.sendMessage({
      action: "cancelScan",
      scanId,
    });

    if (resp?.error) throw new Error(resp.error);

    if (resp?.cancelled === false && state.activeScanId === scanId) {
      $("progressLabel").textContent = _("scanCancelUnavailable");
    }
  } catch (err) {
    if (state.activeScanId === scanId) {
      state.scanCancelRequested = false;
      setScanUiRunning(true);
      showError(_("scanCancelFailed", [err.message]));
    }
  }
}

function onBackgroundMessage(msg) {
  if (!isCurrentScanMessage(msg, state.activeScanId)) return;

  if (msg.type === "scan-started") {
    $("progressContainer").hidden = false;
    $("progressLabel").textContent = _("scanRunningMultiLabel");
  }

  if (msg.type === "scan-progress") {
    const pct = msg.total > 0 ? Math.round((msg.processed / msg.total) * 100) : 0;
    $("progressBar").value = pct;
    $("progressLabel").textContent = `${msg.processed} / ${msg.total}`;
  }

  if (msg.type === "scan-cancelled") {
    $("progressContainer").hidden = true;
    $("progressLabel").textContent = _("scanCancelledLabel");
    clearActiveScan();
  }

  if (msg.type === "scan-complete") {
    finishScanFromSenders(msg.senders);
}
}

function updateStatsLabel(extra = "") {
  const mails = state.allSenders.reduce((n, e) => n + e.count, 0);
  const bytes = state.allSenders.reduce((n, e) => n + e.totalSizeBytes, 0);

  $("statsLabel").textContent =
    `${mails} Mails · ${state.allSenders.length} Absender · ${formatSize(bytes)}${extra}`;
}

function showError(msg) {
  const error = document.createElement("p");
  error.style.cssText = "padding:1rem;color:#f38ba8";
  error.textContent = String(msg);
  $("senderList").replaceChildren(error);
}

// ─── Domain Grouping ──────────────────────────────────────────────────────────
const COMMON_SUBDOMAIN_PREFIXES = new Set([
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

const COMMON_SECOND_LEVEL_SUFFIXES = new Set([
  "co",
  "com",
  "net",
  "org",
  "gov",
  "ac",
  "edu",
]);

function emailHost(email) {
  const host = String(email || "")
    .trim()
    .toLowerCase()
    .split("@")[1] || "";

  return host
    .replace(/[>\s]+$/g, "")
    .replace(/^\.+|\.+$/g, "");
}

function normalizeDomain(hostOrEmail) {
  let host = String(hostOrEmail || "").trim().toLowerCase();

  if (host.includes("@")) {
    host = emailHost(host);
  }

  host = host
    .replace(/[>\s]+$/g, "")
    .replace(/^\.+|\.+$/g, "");

  if (!host) return _("statusUnknown");

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

function senderDomain(email) {
  return normalizeDomain(email);
}

// Domain-Gruppierung hängt nur von der allSenders-Liste ab. Sie wird neu
// zugewiesen bei Scan/Aktionen, bleibt aber beim Filtern dieselbe Referenz —
// daher genügt ein Referenz-Cache, um die Neuberechnung pro Tastendruck zu
// vermeiden. invalidateDomainGroupsCache() deckt In-Place-Mutationen ab.
let domainGroupsCache = { source: null, result: null };

function invalidateDomainGroupsCache() {
  domainGroupsCache = { source: null, result: null };
}

function getDomainGroups(senders) {
  if (domainGroupsCache.source === senders) {
    return domainGroupsCache.result;
  }
  const result = computeDomainGroups(senders);
  domainGroupsCache = { source: senders, result };
  return result;
}

function computeDomainGroups(senders) {
  const groups = new Map();

  for (const s of senders) {
    const rawDomain = emailHost(s.email);
    const domain = normalizeDomain(rawDomain);

    if (!groups.has(domain)) {
      groups.set(domain, {
        domain,
        displayName: domain,
        email: domain,
        rawDomains: new Set(),
        senders: [],
        count: 0,
        totalSizeBytes: 0,
        readCount: 0,
        riskScoreSum: 0,
        newestDate: new Date(0),
        oldestDate: new Date(),
        isBulkCandidate: false,
        hasUnsubscribe: false,
        messageIds: [],
      });
    }

    const g = groups.get(domain);

    if (rawDomain) g.rawDomains.add(rawDomain);

    g.senders.push(s);
    g.count += s.count || 0;
    g.totalSizeBytes += s.totalSizeBytes || 0;
    g.readCount += s.readCount || 0;
    g.riskScoreSum += s.riskScore || 0;

    if (s.newestDate > g.newestDate) g.newestDate = s.newestDate;
    if (s.oldestDate < g.oldestDate) g.oldestDate = s.oldestDate;
    if (s.isBulkCandidate) g.isBulkCandidate = true;
    if (s.hasUnsubscribe) g.hasUnsubscribe = true;

    g.messageIds.push(...(s.messageIds || []));
  }

  return Array.from(groups.values()).map(g => ({
    ...g,
    rawDomains: [...g.rawDomains].sort((a, b) => a.localeCompare(b)),
    rawDomainCount: g.rawDomains.size,
    riskScore: g.senders.length > 0
      ? Math.round(g.riskScoreSum / g.senders.length)
      : 0,
  }));
}

// ─── Row lookup helper (avoids fragile CSS.escape in selectors) ───────────────
function findRow(email) {
  return [...$("senderList").children].find(r => r.dataset.email === email);
}

// ─── Roving tabindex ──────────────────────────────────────────────────────────
// Nur eine Zeile ist per Tab erreichbar (tabindex=0); Pfeiltasten bewegen den
// Fokus. So entsteht bei großen Mailboxen kein Tab-Stop pro Zeile.
const ROW_SELECTOR = ".sender-row, .message-row";

function setActiveRow(row) {
  if (!row) return;
  const prev = $("senderList").querySelector('[tabindex="0"]');
  if (prev && prev !== row) prev.tabIndex = -1;
  row.tabIndex = 0;
}

/** Stellt sicher, dass genau eine Zeile per Tab erreichbar ist. */
function ensureActiveRow() {
  const list = $("senderList");
  if (list.querySelector('[tabindex="0"]')) return;
  const first = list.querySelector(ROW_SELECTOR);
  if (first) first.tabIndex = 0;
}

// ─── Filter + Sort ────────────────────────────────────────────────────────────
function applyFilter() {
  const q = $("filterInput").value.trim().toLowerCase();

  // Always filter senders first (base for everything)
  state.filteredSenders = state.allSenders.filter(sender => {
    const matchesText =
      !q ||
      sender.email.toLowerCase().includes(q) ||
      String(sender.displayName || "").toLowerCase().includes(q);

    return matchesText &&
      matchesQuickFilter(sender) &&
      matchesAdvancedFilter(sender, state.advancedFilter);
  });

  if (state.viewMode === "domains") {
    // Group only the filtered senders? Or group all and then filter domains?
    // User probably expects to see domains that CONTAIN at least one matching sender.
    // Or domains that match the text filter themselves.
    const allGroups = getDomainGroups(state.allSenders);

    state.filteredDomains = allGroups.filter(g => {
      const matchesText = !q || g.domain.toLowerCase().includes(q);
      const hasMatchingSender = g.senders.some(s => {
        const sMatchesText = !q || s.email.toLowerCase().includes(q) || String(s.displayName || "").toLowerCase().includes(q);
        return sMatchesText &&
          matchesQuickFilter(s) &&
          matchesAdvancedFilter(s, state.advancedFilter);
      });

      return matchesText || hasMatchingSender;
    });
  }

  sortAndRender();
  updateFilterStatsLabel();
  updateBulkUnsubBtn();
  scheduleFeatureStatusUpdate();
}

function updateFilterStatsLabel() {
  if (!state.allSenders.length) return;

  const visibleMails = state.filteredSenders.reduce((n, e) => n + e.count, 0);
  const totalMails = state.allSenders.reduce((n, e) => n + e.count, 0);

  if (state.viewMode === "domains") {
    const totalDomains = getDomainGroups(state.allSenders).length;
    $("statsLabel").textContent =
      `${visibleMails} von ${totalMails} Mails · ` +
      `${state.filteredDomains.length} von ${totalDomains} Domains`;
    return;
  }

  const visibleBytes = state.filteredSenders.reduce((n, e) => n + e.totalSizeBytes, 0);
  const totalBytes = state.allSenders.reduce((n, e) => n + e.totalSizeBytes, 0);

  if (state.filteredSenders.length === state.allSenders.length && state.quickFilter === "all" && !$("filterInput").value.trim()) {
    updateStatsLabel();
    return;
  }

  $("statsLabel").textContent =
    `${visibleMails} von ${totalMails} Mails · ` +
    `${state.filteredSenders.length} von ${state.allSenders.length} Absendern · ` +
    `${formatSize(visibleBytes)} von ${formatSize(totalBytes)}`;
}

function setSort(key) {
  state.sortDesc = state.sortKey === key ? !state.sortDesc : key !== "email";
  state.sortKey  = key;
  const sortSelect = $("sortSelect");
  if (sortSelect && sortSelect.value !== state.sortKey) sortSelect.value = state.sortKey;
  sortAndRender();
}

function updateSortHeaders() {
  for (const th of document.querySelectorAll("#tableHeader [data-sort]")) {
    if (th.dataset.sort === state.sortKey) {
      th.dataset.sortActive = state.sortDesc ? "desc" : "asc";
    } else {
      delete th.dataset.sortActive;
    }
  }
}

function sortAndRender() {
  const { sortKey: key, sortDesc: desc } = state;

  updateSortHeaders();

  const sorter = (a, b) => {
    let av = a[key], bv = b[key];
    if (av instanceof Date) { av = av.getTime(); bv = bv.getTime(); }
    if (typeof av === "string") { av = av.toLowerCase(); bv = bv.toLowerCase(); }
    return av < bv ? (desc ? 1 : -1) : av > bv ? (desc ? -1 : 1) : 0;
  };

  state.filteredSenders.sort(sorter);

  if (state.detailEmail && !state.filteredSenders.some(sender => sender.email === state.detailEmail)) {
    state.detailEmail = null;
  }
  renderDetailPanel();

  if (state.viewMode === "domains") {
    state.filteredDomains.sort(sorter);
  }

  renderSenders();
}

// ─── Render ───────────────────────────────────────────────────────────────────
let renderToken = 0;

function getRenderableRows() {
  const rows = [];

  const pushSender = (entry, nested = false) => {
    rows.push({ type: "sender", entry, nested });
    if (!state.expandedSenders.has(entry.email)) return;

    const bucket = state.senderMessages.get(entry.email);
    if (!bucket) {
      rows.push({ type: "messageLoading", senderEmail: entry.email });
      return;
    }
    for (const meta of bucket.metas) {
      rows.push({ type: "message", meta, senderEmail: entry.email });
      if (state.expandedPreviews.has(meta.id)) {
        rows.push({ type: "preview", meta });
      }
    }
    if (bucket.loadedCount < bucket.total) {
      rows.push({
        type: "loadMore",
        senderEmail: entry.email,
        remaining: bucket.total - bucket.loadedCount,
      });
    }
  };

  if (state.viewMode === "senders") {
    for (const entry of state.filteredSenders) pushSender(entry);
    return rows;
  }

  // Set für O(1)-Mitgliedschaftsprüfung statt Array.includes (O(n)) je Absender.
  const filteredSet = new Set(state.filteredSenders);
  for (const domain of state.filteredDomains) {
    rows.push({ type: "domain", entry: domain });
    if (state.expandedDomains.has(domain.domain)) {
      for (const s of domain.senders) {
        if (filteredSet.has(s)) pushSender(s, true);
      }
    }
  }
  return rows;
}

function renderSenders() {
  const list = $("senderList");
  const token = ++renderToken;
  const rows = getRenderableRows();

  // Welcome banner: show when empty and no active scan
  const banner = $("welcomeBanner");
  if (banner) {
    banner.hidden = rows.length > 0 || state.activeScanId !== null;
  }
  const chunkSize = 250;

  list.innerHTML = "";

  let index = 0;

  function renderChunk() {
    if (token !== renderToken) return;

    const fragment = document.createDocumentFragment();
    const end = Math.min(index + chunkSize, rows.length);

    for (; index < end; index++) {
      const item = rows[index];
      if (item.type === "domain") {
        fragment.appendChild(createDomainRow(item.entry));
      } else if (item.type === "sender") {
        fragment.appendChild(createSenderRow(item.entry, item.nested));
      } else if (item.type === "message") {
        fragment.appendChild(createMessageRow(item.meta, item.senderEmail));
      } else if (item.type === "messageLoading") {
        fragment.appendChild(createMessageInfoRow("Mails werden geladen …"));
      } else if (item.type === "loadMore") {
        fragment.appendChild(createLoadMoreRow(item.senderEmail, item.remaining));
      } else if (item.type === "preview") {
        fragment.appendChild(createPreviewRow(item.meta));
      }
    }

    list.appendChild(fragment);

    if (index < rows.length) {
      requestAnimationFrame(renderChunk);
      return;
    }

    ensureActiveRow();
    updateSelectionLabel();
    syncSelectAll();

    for (const email of state.expandedSenders) {
      const bucket = state.senderMessages.get(email);
      if (bucket) loadAttachmentFlags(bucket.metas);
    }
  }

  renderChunk();
}

function icon(name) {
  return `<svg class="icon" aria-hidden="true"><use href="#icon-${name}" /></svg>`;
}

function showSenderDetail(email) {
  state.detailEmail = email;
  renderDetailPanel();
}

function renderDetailPanel() {
  const panel = $("detailPanel");
  if (!panel) return;
  const entry = state.allSenders.find(sender => sender.email === state.detailEmail);
  if (!entry) {
    panel.innerHTML = `<div class="detail-empty">${_("detail_empty")}</div>`;
    return;
  }
  const readPct = entry.count ? Math.round((entry.readCount / entry.count) * 100) : 0;
  const subjects = (entry.sampleSubjects || []).slice(0, 3);
  panel.innerHTML = `
    <div class="detail-heading"><div><h2>${escapeHtml(entry.displayName || entry.email)}</h2><div class="detail-email">${escapeHtml(entry.email)}</div></div><span class="risk-badge ${entry.riskScore >= 70 ? "risk-high" : entry.riskScore >= 40 ? "risk-mid" : "risk-low"}">${entry.riskScore}</span></div>
    <dl class="detail-stats"><div><dt>${_("detail_mails")}</dt><dd>${entry.count}</dd></div><div><dt>${_("detail_storage")}</dt><dd>${formatSize(entry.totalSizeBytes)}</dd></div><div><dt>${_("detail_read")}</dt><dd>${readPct}%</dd></div></dl>
    <h3>${_("detail_subjects")}</h3><ul class="detail-subjects">${subjects.length ? subjects.map(subject => `<li>${escapeHtml(subject)}</li>`).join("") : `<li>${_("detail_no_subjects")}</li>`}</ul>
    <div class="detail-actions">
      <button class="detail-protect">${icon("shield")} ${state.protectedEmails.has(entry.email) ? _("detail_unprotect") : _("detail_protect")}</button>
      <button class="detail-unsubscribe" ${entry.messageIds?.length ? "" : "disabled"}>${icon("unsubscribe")} ${_("action_unsubscribe")}</button>
      <button class="detail-messages">${icon("mail")} ${_("detail_show_mails")}</button>
    </div>`;
  panel.querySelector(".detail-protect").addEventListener("click", () => toggleProtect(entry.email));
  panel.querySelector(".detail-unsubscribe").addEventListener("click", async () => {
    await handleUnsubscribe(entry);
  });
  panel.querySelector(".detail-messages").addEventListener("click", () => toggleSenderExpand(entry.email));
}

// ─── Mail-Inspektion: Laden ─────────────────────────────────────────────────

const MESSAGE_PAGE_SIZE = 50;

/** Führt `mapper` über `items` aus, höchstens `limit` gleichzeitig. */
async function mapLimit(items, limit, mapper) {
  const results = [];
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const chunkResults = await Promise.all(chunk.map(mapper));
    results.push(...chunkResults);
  }
  return results;
}

/**
 * Legt den Nachrichten-Bucket eines Absenders an (IDs aus dem Scan, bereits
 * newest-first sortiert) und lädt die erste Seite Header. Kein erneutes Anlegen,
 * wenn der Bucket schon existiert.
 */
async function loadSenderMessages(entry) {
  if (state.senderMessages.has(entry.email)) return;

  const ids = Array.isArray(entry.messageIds) ? entry.messageIds.slice() : [];
  const bucket = { ids, metas: [], total: ids.length, loadedCount: 0 };
  state.senderMessages.set(entry.email, bucket);

  await loadMessagePage(bucket);
}

/**
 * Lädt die nächste Seite Mail-Header in den Bucket. `loadedCount` zählt die
 * verarbeiteten IDs (auch fehlgeschlagene), damit der Seiten-Offset stabil bleibt;
 * `metas` enthält nur die erfolgreich geladenen Header.
 */
async function loadMessagePage(bucket) {
  const start = bucket.loadedCount;
  const pageIds = bucket.ids.slice(start, start + MESSAGE_PAGE_SIZE);
  if (pageIds.length === 0) return;

  const headers = await mapLimit(pageIds, 20, async id => {
    try {
      const h = await browser.messages.get(id);
      return {
        id,
        subject: h.subject || _("noSubject"),
        date: h.date instanceof Date ? h.date : new Date(h.date),
        read: !!h.read,
        sizeBytes: h.size || 0,
        hasAttachments: undefined,
      };
    } catch {
      return null;
    }
  });

  for (const m of headers) {
    if (m) bucket.metas.push(m);
  }
  bucket.loadedCount = start + pageIds.length;
}

/**
 * Ermittelt für noch unbekannte Mail-Metas lazy, ob sie Anhänge haben,
 * und trägt das Ergebnis nach. Rendert danach neu.
 */
async function loadAttachmentFlags(metas) {
  const pending = metas.filter(m => m.hasAttachments === undefined);
  if (pending.length === 0) return;

  await mapLimit(pending, 30, async meta => {
    try {
      const list = await browser.messages.listAttachments(meta.id);
      meta.hasAttachments = Array.isArray(list) && list.length > 0;
    } catch {
      meta.hasAttachments = false;
    }
  });

  renderSenders();
}

/** Klappt einen Absender auf/zu. */
async function toggleSenderExpand(email) {
  if (state.expandedSenders.has(email)) {
    state.expandedSenders.delete(email);
    renderSenders();
    return;
  }

  const entry = state.allSenders.find(s => s.email === email);
  if (!entry) return;

  state.expandedSenders.add(email);
  renderSenders();
  await loadSenderMessages(entry);
  renderSenders();
}

/** Lädt die nächste Seite Mail-Header eines aufgeklappten Absenders. */
async function loadMoreSenderMessages(email) {
  const bucket = state.senderMessages.get(email);
  if (!bucket || bucket.loadedCount >= bucket.total) return;
  await loadMessagePage(bucket);
  renderSenders();
}

// ─── Mail-Inspektion: Render ────────────────────────────────────────────────

/** Eine einzelne Mail-Zeile unter einem aufgeklappten Absender. */
function createMessageRow(meta, senderEmail) {
  const row = document.createElement("div");
  row.className = "message-row";
  row.dataset.messageId = String(meta.id);
  row.dataset.senderEmail = senderEmail;
  row.tabIndex = -1;  // roving tabindex: erste Zeile wird nach dem Render aktiv
  row.draggable = true;
  row.setAttribute("role", "row");

  // Auswahlzustand beim Neu-Rendern (z. B. Auf-/Zuklappen) wiederherstellen.
  const selected = isMessageSelected(meta.id);
  if (selected) row.classList.add("selected");
  row.setAttribute("aria-selected", selected ? "true" : "false");

  const attach = meta.hasAttachments
    ? `<span class="message-attach" title="${_("attachmentsShow")}">📎</span>`
    : "";

  const checkboxLabel = _("messageSelectAria", [meta.subject || _("noSubject")]);

  row.innerHTML = `
    <input type="checkbox" class="message-checkbox" value="${meta.id}" data-message-id="${meta.id}" title="${_("messageSelect")}" aria-label="${checkboxLabel}" ${selected ? "checked" : ""} />
    <span class="message-read ${meta.read ? "" : "unread"}" title="${meta.read ? _("messageRead") : _("messageUnread")}">${meta.read ? "○" : "●"}</span>
    <span class="message-subject" title="${escapeHtml(meta.subject)}">${escapeHtml(meta.subject)}</span>
    <span class="message-date">${formatRelativeDate(meta.date)}</span>
    <span class="message-size">${formatSize(meta.sizeBytes)}</span>
    <span class="message-attach-cell">${attach}</span>
  `;

  row.addEventListener("click", e => {
    if (e.target.closest(".message-checkbox")) {
      e.stopPropagation();
      return; // Checkbox handles its own change event
    }
    if (e.target.closest(".message-attach")) {
      e.stopPropagation();
      openAttachmentDialog(meta);
      return;
    }
    toggleMessagePreview(meta);
  });

  return row;
}

/** Info-Zeile (z. B. „Mails werden geladen …"). */
function createMessageInfoRow(text) {
  const row = document.createElement("div");
  row.className = "message-info-row";
  row.textContent = text;
  return row;
}

/** „Weitere laden"-Zeile. */
function createLoadMoreRow(senderEmail, remaining) {
  const row = document.createElement("div");
  row.className = "message-loadmore-row";
  row.innerHTML = `<button type="button">${_("messageLoadMore", [remaining])}</button>`;
  row.querySelector("button").addEventListener("click", e => {
    e.stopPropagation();
    e.currentTarget.disabled = true;
    loadMoreSenderMessages(senderEmail);
  });
  return row;
}

/** Klappt die Inline-Vorschau einer Mail auf/zu und lädt den Text bei Bedarf. */
async function toggleMessagePreview(meta) {
  if (state.expandedPreviews.has(meta.id)) {
    state.expandedPreviews.delete(meta.id);
    renderSenders();
    return;
  }

  state.expandedPreviews.add(meta.id);
  renderSenders();

  if (state.messagePreviews.has(meta.id)) return;

  try {
    const full = await browser.messages.getFull(meta.id);
    const text = extractPreviewText(full, { maxLines: 10, maxChars: 800 });
    state.messagePreviews.set(meta.id, text || _("messagePreview_noContent"));
  } catch {
    state.messagePreviews.set(meta.id, _("messagePreview_loadFailed"));
  }
  if (state.expandedPreviews.has(meta.id)) renderSenders();
}

/** Der Inline-Vorschaublock unter einer Mail-Zeile. */
function createPreviewRow(meta) {
  const row = document.createElement("div");
  row.className = "message-preview";

  if (state.messagePreviews.has(meta.id)) {
    row.textContent = state.messagePreviews.get(meta.id);
  } else {
    row.textContent = _("messagePreview_loading");
    row.classList.add("loading");
  }
  return row;
}

// ─── Mail-Inspektion: Anhänge ───────────────────────────────────────────────

/** Speichert eine File-Instanz über einen programmatischen Download-Klick. */
function downloadFile(file, name) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = name || file.name || _("attachmentFallbackName");
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Öffnet eine File-Instanz in einem neuen Browser-Tab. */
function openFileInTab(file) {
  const url = URL.createObjectURL(file);
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Öffnet den Anhang-Dialog für eine Mail. */
async function openAttachmentDialog(meta) {
  const dialog = $("attachmentDialog");
  const list = $("attachmentList");
  $("attachmentDialogTitle").textContent = _("attachmentDialogTitleDynamic", [meta.subject]);
  list.innerHTML = `<div class="attachment-empty">${_("attachmentLoading")}</div>`;
  dialog.showModal();
  state.attachmentDialogMeta = meta;

  let attachments = state.messageAttachments.get(meta.id);
  if (!attachments) {
    try {
      const raw = await browser.messages.listAttachments(meta.id);
      attachments = (raw || []).map(a => ({
        partName: a.partName,
        name: a.name || _("attachmentFallbackName"),
        size: a.size || 0,
        contentType: a.contentType || "",
      }));
      state.messageAttachments.set(meta.id, attachments);
    } catch {
      attachments = [];
    }
  }

  if (attachments.length === 0) {
    list.innerHTML = `<div class="attachment-empty">${_("attachmentEmpty")}</div>`;
    return;
  }

  list.innerHTML = "";
  for (const att of attachments) {
    const item = document.createElement("div");
    item.className = "attachment-item";
    item.innerHTML = `
      <span class="attachment-name" title="${escapeHtml(att.name)}">📄 ${escapeHtml(att.name)}</span>
      <span class="attachment-size">${formatSize(att.size)}</span>
      <button type="button" class="attachment-open">${_("attachmentOpen")}</button>
      <button type="button" class="attachment-save">${_("attachmentSave")}</button>
    `;
    item.querySelector(".attachment-open").addEventListener("click", async () => {
      const file = await browser.messages.getAttachmentFile(meta.id, att.partName);
      openFileInTab(file);
    });
    item.querySelector(".attachment-save").addEventListener("click", async () => {
      const file = await browser.messages.getAttachmentFile(meta.id, att.partName);
      downloadFile(file, att.name);
    });
    list.appendChild(item);
  }
}

/** Speichert alle Anhänge der zuletzt im Dialog gezeigten Mail. */
async function saveAllAttachments(meta) {
  const attachments = state.messageAttachments.get(meta.id) || [];
  for (const att of attachments) {
    const file = await browser.messages.getAttachmentFile(meta.id, att.partName);
    downloadFile(file, att.name);
  }
}

// ─── Mail-Inspektion: Kontextmenü ───────────────────────────────────────────

/** Schließt das offene Kontextmenü, falls vorhanden. */
function closeRowContextMenu() {
  const existing = $("rowContextMenu");
  if (existing) existing.remove();
}

/**
 * Zeigt ein Kontextmenü an Position (x, y).
 * items: Array aus "separator" oder { label, danger?, action }.
 */
function showRowContextMenu(x, y, items) {
  closeRowContextMenu();

  const menu = document.createElement("div");
  menu.id = "rowContextMenu";
  menu.className = "row-context-menu";

  for (const item of items) {
    if (item === "separator") {
      const sep = document.createElement("div");
      sep.className = "row-context-separator";
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "row-context-item" + (item.danger ? " danger" : "");
    btn.textContent = item.label;
    btn.addEventListener("click", () => {
      closeRowContextMenu();
      item.action();
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - rect.width - 4);
  const py = Math.min(y, window.innerHeight - rect.height - 4);
  menu.style.left = `${Math.max(4, px)}px`;
  menu.style.top = `${Math.max(4, py)}px`;
}

/** Setzt die Auswahl auf genau einen Absender und frischt die UI auf. */
function selectOnlySender(email) {
  state.selected = new Set([email]);
  renderSenders();
  updateSelectionLabel();
  updateActionButtons();
  syncSelectAll();
  updateCleanupAssistant();
  scheduleFeatureStatusUpdate();
}

/** Menüeinträge für eine Absender-Zeile. */
function senderContextItems(entry) {
  const isProtected = state.protectedEmails.has(entry.email);
  return [
    { label: _("senderContext_openLatest"), action: () => openSenderMessage(entry) },
    { label: _("senderContext_toggleMessages"), action: () => toggleSenderExpand(entry.email) },
    "separator",
    { label: _("senderContext_addSelection"), action: () => {
        state.selected.add(entry.email);
        renderSenders(); updateSelectionLabel(); updateActionButtons();
        syncSelectAll(); updateCleanupAssistant(); scheduleFeatureStatusUpdate();
      } },
    { label: _("trashSenderLabel"), danger: true, action: () => {
        selectOnlySender(entry.email);
        openConfirmDialog("trash");
      } },
    { label: _("senderContext_moveToFolder"), action: () => {
        selectOnlySender(entry.email);
        openFolderDialog();
      } },
    { label: _("senderContext_assignTag"), action: () => {
        selectOnlySender(entry.email);
        openTagDialog();
      } },
    { label: _("senderContext_unsubscribe"), action: () => {
        selectOnlySender(entry.email);
        handleUnsubscribe();
      } },
    { label: _("senderContext_applyRule"), action: () => {
        selectOnlySender(entry.email);
        applyCleanupRuleForCurrentSelection();
      } },
    "separator",
    { label: isProtected ? _("senderContext_removeProtection") : _("senderContext_protectSender"),
      action: () => toggleProtect(entry.email) },
    { label: _("senderContext_copyAddress"), action: () => navigator.clipboard.writeText(entry.email) },
  ];
}

/** Menüeinträge für eine einzelne Mail-Zeile. */
function messageContextItems(meta) {
  const items = [
    { label: _("messageContext_openInThunderbird"), action: () => {
        browser.runtime.sendMessage({ action: "openMessage", messageId: meta.id })
          .catch(() => {}); // background event page may not be ready
      } },
    { label: _("messageContext_reply"), action: () => {
        browser.compose.beginReply(meta.id)
          .catch(() => showError(_("replyOpenFailed")));
      } },
    { label: _("messageContext_togglePreview"), action: () => toggleMessagePreview(meta) },
  ];
  if (meta.hasAttachments) {
    items.push({ label: _("messageContext_attachments"), action: () => openAttachmentDialog(meta) });
  }
  items.push("separator");
  items.push({ label: _("messageContext_trash"), danger: true, action: () => trashSingleMessage(meta) });
  items.push({ label: _("messageContext_copySubject"), action: () => navigator.clipboard.writeText(meta.subject) });
  return items;
}

/** Verschiebt genau eine Mail in den Papierkorb (über den bestehenden performAction-Pfad). */
async function trashSingleMessage(meta) {
  const accountId = $("accountSelect")?.value || "";
  const folderId = $("folderSelect")?.value || "";
  try {
    const response = await browser.runtime.sendMessage({
      action: "performAction",
      type: "trash",
      messageIds: [meta.id],
      accountId,
      folderId,
      options: {},
    });
    if (response?.error) {
      showError("Mail konnte nicht verschoben werden: " + response.error);
      return;
    }
    // betroffene Mail aus den Caches entfernen, statt den ganzen Bucket zu verwerfen
    for (const bucket of state.senderMessages.values()) {
      const i = bucket.metas.findIndex(m => m.id === meta.id);
      if (i !== -1) {
        bucket.metas.splice(i, 1);
        const idIdx = bucket.ids.indexOf(meta.id);
        if (idIdx !== -1) {
          bucket.ids.splice(idIdx, 1);
          bucket.total -= 1;
          if (idIdx < bucket.loadedCount) bucket.loadedCount -= 1;
        }
      }
    }
    for (const entry of state.allSenders) {
      if (Array.isArray(entry.messageIds)) {
        const i = entry.messageIds.indexOf(meta.id);
        if (i !== -1) entry.messageIds.splice(i, 1);
      }
    }
    state.expandedPreviews.delete(meta.id);
    state.messagePreviews.delete(meta.id);
    state.messageAttachments.delete(meta.id);
    renderSenders();
  } catch (e) {
    showError("Mail konnte nicht verschoben werden: " + e.message);
  }
}

function createSenderRow(entry, nested = false) {
  const isProtected = state.protectedEmails.has(entry.email);
  const isSelected  = state.selected.has(entry.email);
  const readPct     = entry.count > 0 ? Math.round((entry.readCount / entry.count) * 100) : 0;
  const readClass   = readPct < 10 ? "low" : readPct < 40 ? "mid" : "";
  const riskClass   = entry.riskScore >= 70 ? "risk-high" : entry.riskScore >= 40 ? "risk-mid" : "risk-low";
  const riskDots    = entry.riskScore >= 70 ? "●●●"        : entry.riskScore >= 40 ? "●●○"       : "●○○";

  const row = document.createElement("div");
  row.className = ["sender-row", isProtected && "protected", isSelected && "selected", nested && "nested"]
    .filter(Boolean).join(" ");
  row.dataset.email = entry.email;
  row.tabIndex = -1;  // roving tabindex: erste Zeile wird nach dem Render aktiv
  row.draggable = true;
  row.setAttribute("role", "row");
  row.setAttribute("aria-selected", isSelected ? "true" : "false");

  const safeEmail = escapeHtml(entry.email);
  const safeDisplayName = escapeHtml(entry.displayName || entry.email);
  const safeSubjects = entry.sampleSubjects
    .map(s => `"${escapeHtml(s)}"`)
    .join(" · ");
  const scoreTitle = escapeHtml(cleanupScoreTooltip(entry));

  const bulkBadge = entry.isBulkCandidate
    ? `<span class="sender-flag" title="Newsletter/Bulk-Kandidat: ${escapeHtml((entry.bulkReasons || []).join(", "))}">📨</span>`
    : "";

  const unsubscribeBadge = entry.hasUnsubscribe
    ? `<span class="sender-flag" title="Abmeldung möglich (List-Unsubscribe-Header)">🚫</span>`
    : "";

  const protectSuggestionBadge = isProtectionCandidate(entry)
    ? `<span class="sender-flag" title="${escapeHtml(protectionCandidateReason(entry))}">🛡️</span>`
    : "";

  const regexMatch = matchCustomRegexRules(entry);
  const regexBadge = regexMatch
    ? `<span class="sender-flag custom-regex-badge" title="RegEx-Treffer: ${escapeHtml(regexMatch)}">🔍</span>`
    : "";

  row.innerHTML = `
    <input type="checkbox" class="row-check" aria-label="Absender ${safeDisplayName} auswählen" ${isSelected ? "checked" : ""} ${isProtected ? "disabled" : ""} />
    <div class="sender-main">
      <div class="sender-email" title="${safeEmail}">${
        entry.count > 1
          ? `<span class="sender-expand-toggle" title="Mails anzeigen">${state.expandedSenders.has(entry.email) ? "▾" : "▸"}</span>`
          : `<span class="sender-expand-spacer"></span>`
      }${isProtected ? "📌 " : ""}${safeDisplayName}<span class="sender-flags">${bulkBadge}${unsubscribeBadge}${protectSuggestionBadge}${regexBadge}</span></div>
      <div class="sender-subjects">${safeSubjects}</div>
    </div>
    <span class="col-count">${entry.count}</span>
    <span class="col-size">${formatSize(entry.totalSizeBytes)}</span>
    <span class="col-read ${readClass}">${readPct}%</span>
    <span class="col-date">${formatRelativeDate(entry.newestDate)}</span>
    <span class="risk-badge ${riskClass}" title="${scoreTitle}" aria-label="${scoreTitle}">${entry.riskScore} ${riskDots}</span>
    <span class="row-actions">
      <button class="open-msg-btn" title="Neueste Mail öffnen">↗</button>
      <button class="protect-btn" title="${isProtected ? "Schutz aufheben" : "Schützen"}">${isProtected ? "🔓" : "🛡"}</button>
      <button class="trash-row-btn" title="Alle Mails dieses Absenders in den Papierkorb">🗑</button>
    </span>
  `;

  const checkbox = row.querySelector(".row-check");

  checkbox.addEventListener("click", e => {
    e.stopPropagation();
  });

  checkbox.addEventListener("change", e => {
    toggleRowSelect(entry.email, e.target.checked);
    state.lastSelectedEmail = entry.email;
  });

  row.querySelector(".protect-btn").addEventListener("click", e => {
    e.stopPropagation();
    toggleProtect(entry.email);
  });

  const expandToggle = row.querySelector(".sender-expand-toggle");
  if (expandToggle) {
    expandToggle.addEventListener("click", e => {
      e.stopPropagation();
      toggleSenderExpand(entry.email);
    });
  }

  row.addEventListener("click", e => {
    handleSenderRowClick(entry, e);
    showSenderDetail(entry.email);
  });

  row.querySelector(".open-msg-btn").addEventListener("click", e => {
    e.stopPropagation();
    openSenderMessage(entry);
  });

  row.querySelector(".trash-row-btn").addEventListener("click", e => {
    e.stopPropagation();
    state.selected = new Set([entry.email]);
    renderSenders();
    updateSelectionLabel();
    updateActionButtons();
    syncSelectAll();
    updateCleanupAssistant();
    scheduleFeatureStatusUpdate();
    openConfirmDialog("trash");
  });

  row.addEventListener("dblclick", e => {
    if (isTypingTarget(e.target)) return;
    if (e.target.closest("button,input,select,textarea")) return;
    openSenderMessage(entry);
  });

  return row;
}

function createDomainRow(entry) {
  const isExpanded = state.expandedDomains.has(entry.domain);
  const senders = entry.senders;

  // Selection state for domain
  const selectedCount = senders.filter(s => state.selected.has(s.email)).length;
  const allSelected = selectedCount > 0 && selectedCount === senders.length;
  const partialSelected = selectedCount > 0 && selectedCount < senders.length;

  const readPct   = entry.count > 0 ? Math.round((entry.readCount / entry.count) * 100) : 0;
  const readClass = readPct < 10 ? "low" : readPct < 40 ? "mid" : "";
  const riskClass = entry.riskScore >= 70 ? "risk-high" : entry.riskScore >= 40 ? "risk-mid" : "risk-low";
  const riskDots  = entry.riskScore >= 70 ? "●●●"        : entry.riskScore >= 40 ? "●●○"       : "●○○";

  const row = document.createElement("div");
  row.className = "sender-row domain-row";
  row.dataset.domain = entry.domain;
  row.tabIndex = -1;  // roving tabindex: erste Zeile wird nach dem Render aktiv
  row.setAttribute("role", "row");
  row.setAttribute("aria-selected", allSelected ? "true" : "false");

  const bulkBadge = entry.isBulkCandidate
    ? `<span class="bulk-badge">${_("domainBulk")}</span>`
    : "";

  const unsubscribeBadge = entry.hasUnsubscribe
    ? `<span class="unsub-badge">${_("domainUnsubscribe")}</span>`
    : "";

  const domainCheckboxLabel = `Domain ${escapeHtml(entry.domain)} (${senders.length} Absender) auswählen`;

  row.innerHTML = `
    <input type="checkbox" class="row-check" aria-label="${domainCheckboxLabel}" ${allSelected ? "checked" : ""} />
    <div class="sender-main">
      <div class="sender-email">
        <span class="toggle-icon ${isExpanded ? "expanded" : ""}">▶</span>
        ${escapeHtml(entry.domain)}
        <span style="font-size: 0.8em; font-weight: normal; color: var(--text-dim); margin-left: 8px;">
          (${senders.length} Absender${entry.rawDomainCount > 1 ? ` · ${entry.rawDomainCount} Subdomains` : ""})
        </span>
      </div>
      <div class="sender-subjects" title="${escapeHtml((entry.rawDomains || []).join(", "))}">
        ${bulkBadge} ${unsubscribeBadge}
        ${senders.length} verschiedene Adressen
        ${entry.rawDomainCount > 1 ? `aus ${entry.rawDomainCount} Subdomains` : ""}
      </div>
    </div>
    <span class="col-count">${entry.count}</span>
    <span class="col-size">${formatSize(entry.totalSizeBytes)}</span>
    <span class="col-read ${readClass}">${readPct}%</span>
    <span class="col-date">${formatRelativeDate(entry.newestDate)}</span>
    <span class="risk-badge ${riskClass}">${entry.riskScore} ${riskDots}</span>
    <span class="row-actions">
      <button class="domain-rule-btn" title="Aufräum-Regel für Domain">⚙</button>
      <button class="domain-clean-btn" title="Alle Mails dieser Domain in den Papierkorb">🗑</button>
    </span>
  `;

  const checkbox = row.querySelector(".row-check");
  if (partialSelected) checkbox.indeterminate = true;

  checkbox.addEventListener("click", e => e.stopPropagation());
  checkbox.addEventListener("change", e => toggleDomainSelect(entry.domain, e.target.checked));

  row.querySelector(".domain-clean-btn").addEventListener("click", async e => {
    e.stopPropagation();
    await openTrashDialogForDomain(entry.domain);
  });

  row.querySelector(".domain-rule-btn").addEventListener("click", async e => {
    e.stopPropagation();
    await openTrashDialogForDomainRule(entry.domain);
  });

  row.addEventListener("click", () => {
    if (state.expandedDomains.has(entry.domain)) {
      state.expandedDomains.delete(entry.domain);
    } else {
      state.expandedDomains.add(entry.domain);
    }
    renderSenders();
  });

  return row;
}

async function openSenderMessage(entry) {
  const messageId = entry.newestMessageId || entry.messageIds?.[0];
  if (!messageId) return;

  try {
    const response = await browser.runtime.sendMessage({
      action: "openMessage",
      messageId,
    });

    if (response?.error) {
      showError("Mail konnte nicht geöffnet werden: " + response.error);
    }
  } catch (_) {
    // background event page not ready — silently ignore
  }
}

// ─── Selection ────────────────────────────────────────────────────────────────
function toggleRowSelect(email, checked) {
  if (checked) { state.selected.add(email); showSenderDetail(email); } else state.selected.delete(email);

  const row = findRow(email);
  if (row) {
    row.classList.toggle("selected", checked);
    row.setAttribute("aria-selected", checked ? "true" : "false");
    const checkbox = row.querySelector(".row-check");
    if (checkbox) checkbox.checked = checked;
  }

  updateSelectionLabel();
  updateActionButtons();
  updateBulkUnsubBtn();
  syncSelectAll();

  if (state.quickFilter === "selected") {
    applyFilter();
  }
  updateCleanupAssistant();
  scheduleFeatureStatusUpdate();
}

function toggleSelectAll() {
  state.selected.clear();
  state.lastSelectedEmail = null;
  if ($("selectAll").checked) {
    if (state.viewMode === "domains") {
      state.filteredDomains.forEach(d => {
        d.senders.forEach(s => {
          if (!state.protectedEmails.has(s.email)) state.selected.add(s.email);
        });
      });
    } else {
      state.filteredSenders
        .filter(s => !state.protectedEmails.has(s.email))
        .forEach(s => state.selected.add(s.email));
    }
  }
  renderSenders();
  updateActionButtons();
  updateBulkUnsubBtn();

  if (state.quickFilter === "selected") {
    applyFilter();
  }
  updateCleanupAssistant();
  scheduleFeatureStatusUpdate();
}

function syncSelectAll() {
  let selectable;
  if (state.viewMode === "domains") {
    selectable = state.filteredDomains.flatMap(d => d.senders).filter(s => !state.protectedEmails.has(s.email));
  } else {
    selectable = state.filteredSenders.filter(s => !state.protectedEmails.has(s.email));
  }

  $("selectAll").checked =
    selectable.length > 0 && selectable.every(s => state.selected.has(s.email));
}

function toggleDomainSelect(domainName, checked) {
  const domain = state.filteredDomains.find(d => d.domain === domainName);
  if (!domain) return;

  for (const s of domain.senders) {
    if (state.protectedEmails.has(s.email)) continue;
    if (checked) state.selected.add(s.email);
    else state.selected.delete(s.email);
  }

  renderSenders();
  updateSelectionLabel();
  updateActionButtons();
  syncSelectAll();
  updateCleanupAssistant();
}

function updateSelectionLabel() {
  const senderCount = state.selected.size;
  const messageCount = getSelectedMessageCount();

  if (senderCount === 0 && messageCount === 0) {
    $("selectionLabel").textContent = "";
    return;
  }

  let label = "";
  if (senderCount > 0 && messageCount > 0) {
    label = `${senderCount + messageCount} ausgewählt`;
  } else if (senderCount > 0) {
    label = `${senderCount} ausgewählt`;
  } else if (messageCount > 0) {
    label = `${messageCount} ausgewählt`;
  }

  $("selectionLabel").textContent = label;
}

function updateActionButtons() {
  const has = state.selected.size > 0 || state.selectedMessages.size > 0;
  ["trashBtn", "folderBtn", "readBtn", "archiveBtn", "tagBtn", "unsubBtn"].forEach(id => { const button = $(id); if (button) button.disabled = !has; });
}

// ─── Message selection helpers ─────────────────────────────────────────────────
function isMessageSelected(messageId) {
  return state.selectedMessages.has(String(messageId));
}

function toggleMessageSelection(messageId) {
  const id = String(messageId);
  if (state.selectedMessages.has(id)) {
    state.selectedMessages.delete(id);
  } else {
    state.selectedMessages.add(id);
  }
}

function clearMessageSelection() {
  state.selectedMessages.clear();
}

function getSelectedMessageCount() {
  return state.selectedMessages.size;
}

// ─── messageIds for the current selection ─────────────────────────────────────
// Vereint Absender-Auswahl (state.selected) und Einzelmail-Auswahl
// (state.selectedMessages, als Strings gespeichert) zu einer deduplizierten
// Number-Liste — der Typ, den die Absender-Pfade und das Backend erwarten.
function selectedMessageIds() {
  const ids = new Set();

  for (const email of state.selected) {
    const sender = state.allSenders.find(e => e.email === email);
    if (sender) {
      for (const id of sender.messageIds) ids.add(id);
    }
  }

  for (const id of state.selectedMessages) {
    ids.add(Number(id));
  }

  return [...ids];
}

function selectedSenderGroups() {
  return [...state.selected].map(email => {
    const sender = state.allSenders.find(e => e.email === email);
    return {
      email,
      messageIds: sender ? sender.messageIds : [],
    };
  }).filter(group => group.messageIds.length > 0);
}

function selectedSenderEntries() {
  return [...state.selected]
    .map(email => state.allSenders.find(sender => sender.email === email))
    .filter(Boolean);
}

function senderReadRate(sender) {
  if (!sender || sender.count <= 0) return 0;
  return sender.readCount / sender.count;
}

function senderUnreadRate(sender) {
  if (!sender || sender.count <= 0) return 0;
  return (sender.count - sender.readCount) / sender.count;
}

function senderNewestAgeDays(sender) {
  const date = sender?.newestDate instanceof Date
    ? sender.newestDate
    : new Date(sender?.newestDate);

  if (Number.isNaN(date.getTime())) return null;

  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
}

function senderDomainForSafety(email) {
  return normalizeDomain(email);
}

function looksLikePersonalSender(sender) {
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
    "info@",
  ];

  if (bulkWords.some(word => email.includes(word) || displayName.includes(word))) {
    return false;
  }

  return true;
}

function buildTrashSafetyWarnings() {
  const selected = selectedSenderEntries();
  const warnings = [];

  if (selected.length === 0) return warnings;

  const mailCount = selected.reduce((sum, sender) => sum + (sender.count || 0), 0);
  const domains = new Set(selected.map(sender => senderDomainForSafety(sender.email)).filter(Boolean));

  const recentSenders = selected.filter(sender => {
    const age = senderNewestAgeDays(sender);
    return age !== null && age <= 30;
  });

  const tinySenders = selected.filter(sender => (sender.count || 0) <= 3);
  const personalSenders = selected.filter(looksLikePersonalSender);
  const mostlyReadSenders = selected.filter(sender => senderReadRate(sender) >= 0.75 && (sender.count || 0) >= 5);
  const nonBulkSenders = selected.filter(sender => !sender.isBulkCandidate && !sender.hasUnsubscribe);

  if (recentSenders.length > 0) {
    warnings.push({
      level: "high",
      text:
        _("trashWarningRecentDetailed", [recentSenders.length]),
    });
  }

  if (tinySenders.length > 0 && tinySenders.length >= Math.ceil(selected.length * 0.4)) {
    warnings.push({
      level: "medium",
      text:
        _("trashWarningFewDetailed", [tinySenders.length]),
    });
  }

  if (personalSenders.length > 0 && personalSenders.length >= Math.ceil(selected.length * 0.3)) {
    warnings.push({
      level: "high",
      text:
        _("trashWarningPersonalDetailed", [personalSenders.length]),
    });
  }

  if (mostlyReadSenders.length > 0) {
    warnings.push({
      level: "medium",
      text:
        _("trashWarningReadDetailed", [mostlyReadSenders.length]),
    });
  }

  if (nonBulkSenders.length > 0 && nonBulkSenders.length === selected.length && selected.length > 3) {
    warnings.push({
      level: "medium",
      text:
        _("trashWarningNonBulkDetailed"),
    });
  }

  if (domains.size >= 10) {
    warnings.push({
      level: "medium",
      text:
        _("trashWarningDomainsDetailed", [domains.size]),
    });
  }

  if (mailCount >= 1000) {
    warnings.push({
      level: "high",
      text:
        _("trashWarningManyDetailed", [mailCount]),
    });
  }

  return warnings;
}

function renderTrashSafetyWarnings() {
  const box = $("trashSafetyBox");
  const list = $("trashSafetyList");
  const confirm = $("trashSafetyConfirm");
  const ok = $("confirmOk");

  if (!box || !list || !confirm || !ok) return false;

  const warnings = buildTrashSafetyWarnings();
  const hasHighWarning = warnings.some(w => w.level === "high");

  confirm.checked = false;

  if (warnings.length === 0) {
    box.hidden = true;
    list.innerHTML = "";
    updateTrashConfirmState();
    return false;
  }

  box.hidden = false;
  box.classList.toggle("high", hasHighWarning);

  list.innerHTML = warnings
    .map(w => `<li class="${w.level === "high" ? "high" : "medium"}">${escapeHtml(w.text)}</li>`)
    .join("");

  updateTrashConfirmState();
  return hasHighWarning;
}

function updateTrashConfirmState() {
  const ok = $("confirmOk");
  const confirm = $("trashSafetyConfirm");
  if (!ok || !confirm) return;

  const hasHighWarning = buildTrashSafetyWarnings().some(w => w.level === "high");
  ok.disabled = !canConfirmTrash(
    ok.dataset.previewReady === "true",
    hasHighWarning,
    confirm.checked
  );
}

function bindTrashSafetyConfirm() {
  const confirm = $("trashSafetyConfirm");
  const ok = $("confirmOk");

  if (!confirm || !ok) return;

  confirm.addEventListener("change", updateTrashConfirmState);
}

function isProtectionCandidate(sender) {
  if (!sender?.email) return false;
  if (state.protectedEmails.has(sender.email)) return false;
  if (sender.isBulkCandidate || sender.hasUnsubscribe) return false;

  const age = senderNewestAgeDays(sender);
  const isRecent = age !== null && age <= 30;
  const isTiny = (sender.count || 0) <= 3;
  const isMostlyRead = (sender.count || 0) >= 5 && senderReadRate(sender) >= 0.75;
  const isPersonal = looksLikePersonalSender(sender);

  return isPersonal && (isRecent || isTiny || isMostlyRead);
}

function protectionCandidateReason(sender) {
  const reasons = [];

  const age = senderNewestAgeDays(sender);

  if (age !== null && age <= 30) reasons.push(_("protectionReasonNew"));
  if ((sender.count || 0) <= 3) reasons.push(_("protectionReasonFew"));
  if ((sender.count || 0) >= 5 && senderReadRate(sender) >= 0.75) reasons.push(_("protectionReasonRead"));
  if (looksLikePersonalSender(sender)) reasons.push(_("protectionReasonPersonal"));

  return reasons.join(" · ") || _("protectionReasonRecommended");
}

function prioritizedMessageIdsForSender(sender, limit = 3) {
  const ids = [];

  if (sender?.newestMessageId) ids.push(sender.newestMessageId);

  for (const id of sender?.messageIds || []) {
    ids.push(id);
  }

  return [...new Set(ids)].slice(0, limit);
}

function unsubscribeCheckGroups() {
  let source;

  if (state.selected.size > 0) {
    source = state.allSenders.filter(sender => state.selected.has(sender.email));
  } else {
    const visibleBulk = state.filteredSenders.filter(sender => sender.isBulkCandidate);
    source = visibleBulk.length > 0 ? visibleBulk : state.filteredSenders;
  }

  return source
    .filter(sender => !sender.hasUnsubscribe)
    .slice(0, 500)
    .map(sender => ({
      email: sender.email,
      messageIds: prioritizedMessageIdsForSender(sender, 3),
    }))
    .filter(group => group.messageIds.length > 0);
}

function applyUnsubscribeResults(results) {
  const byEmail = new Map();

  for (const result of results || []) {
    if (result?.email) byEmail.set(result.email, result);
  }

  for (const sender of state.allSenders) {
    const result = byEmail.get(sender.email);
    if (!result) continue;

    sender.unsubscribeChecked = true;
    sender.hasUnsubscribe = Boolean(result.found);
    sender.unsubscribeInfo = result.info || { kind: "none" };
    sender.unsubscribeKind = result.info?.kind || "none";
  }

  // In-Place-Mutation von hasUnsubscribe — Domain-Gruppen-Cache verwerfen.
  invalidateDomainGroupsCache();
}

async function handleCheckUnsubscribeCandidates() {
  if (state.isCheckingUnsubscribe) return;

  const groups = unsubscribeCheckGroups();

  if (groups.length === 0) {
    $("statsLabel").textContent = _("unsubscribe_checkNone");
    return;
  }

  state.isCheckingUnsubscribe = true;

  const btn = $("checkUnsubBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = _("unsubscribe_checkButtonProgress", [String(groups.length)]);
  }

  $("statsLabel").textContent =
    _("unsubscribe_checkProgress", [String(groups.length)]);

  try {
    const response = await browser.runtime.sendMessage({
      action: "checkUnsubscribeForSenders",
      senderGroups: groups,
      limitPerSender: 3,
    });

    if (response?.error) {
      throw new Error(response.error);
    }

    applyUnsubscribeResults(response.results || []);
    updateBulkUnsubBtn();

    const accountId = $("accountSelect").value;
    const folderId = $("folderSelect").value;
    await saveScanCache(accountId, folderId, state.allSenders);

    applyFilter();
    updateCleanupAssistant();

    $("statsLabel").textContent =
      `${response.found || 0} von ${response.checked || 0} geprüften Absendern sind abmeldbar.`;
  } catch (err) {
    showError(_("unsubscribe_checkFailed", [err.message]));
  } finally {
    state.isCheckingUnsubscribe = false;

    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `${icon("search")} ${_("quickFilter_unsubscribe_check", "Check Unsubscribe Links")}`;
    }
  }
}

// ponytail: single source of truth for unsubscribe-eligible senders.
// Respects filter context: uses selected senders if any, otherwise currently filtered/visible.
function unsubscribeActionSenders() {
  const source = state.selected.size > 0
    ? state.allSenders.filter(s => state.selected.has(s.email))
    : state.filteredSenders || state.allSenders;
  return source.filter(s => s.hasUnsubscribe);
}

async function handleBulkUnsubscribe() {
  const unsubSenders = unsubscribeActionSenders();

  if (unsubSenders.length === 0) {
    alert(_("unsubscribe_noSenders"));
    return;
  }
  if (unsubSenders.length > 50) {
    alert(_("unsubscribe_tooMany"));
    return;
  }

  const httpsSenders = [];
  const mailtoSenders = [];

  for (const sender of unsubSenders) {
    let info = sender.unsubscribeInfo;
    if (!info || info.kind === "none") {
      const messageId = sender.newestMessageId || sender.messageIds?.[0];
      if (!messageId) continue;
      info = await browser.runtime.sendMessage({ action: "getUnsubscribeInfo", messageId });
      sender.unsubscribeInfo = info || { kind: "none" };
      sender.unsubscribeKind = info?.kind || "none";
    }
    if (info?.kind === "https") httpsSenders.push({ email: sender.email, url: info.url });
    else if (info?.kind === "mailto") mailtoSenders.push({ email: sender.email, address: info.address, subject: info.subject || "Unsubscribe" });
  }

  const total = httpsSenders.length + mailtoSenders.length;
  if (total === 0) {
    alert(_("unsubscribe_noActionable"));
    return;
  }

  let msg = _("unsubscribe_confirmSummary", [String(total)]);
  if (httpsSenders.length) msg += `\n🌐 ${_("unsubscribe_confirmWeb", [String(httpsSenders.length)])}`;
  if (mailtoSenders.length) msg += `\n📧 ${_("unsubscribe_confirmMail", [String(mailtoSenders.length)])}`;
  msg += `\n\n${_("unsubscribe_proceed")}`;

  if (!confirm(msg)) return;

  for (const { email } of mailtoSenders) {
    const s = mailtoSenders.find(x => x.email === email);
    await browser.runtime.sendMessage({
      action: "doCompose",
      to: s.address,
      subject: s.subject,
    });
  }

  for (const { url } of httpsSenders) {
    // ponytail: open one browser window per sender — browsers handle tabs
    browser.windows.openDefaultBrowser(url);
  }
}

function updateBulkUnsubBtn() {
  const btn = $("bulkUnsubBtn");
  if (!btn) return;
  const count = unsubscribeActionSenders().length;
  btn.style.display = count > 0 ? "" : "none";
  btn.textContent = _("unsubscribe_bulk_count", String(count));
}

function readTrashRules() {
  const olderThanDays = Number.parseInt($("trashOlderThanDays")?.value || "0", 10);
  const keepNewest = Number.parseInt($("trashKeepNewest")?.value || "0", 10);

  return {
    olderThanDays: Number.isFinite(olderThanDays) && olderThanDays > 0 ? olderThanDays : 0,
    keepNewest: Number.isFinite(keepNewest) && keepNewest > 0 ? keepNewest : 0,
    senderGroups: selectedSenderGroups(),
  };
}

function hasActiveTrashRules(options) {
  return Boolean(options?.olderThanDays > 0 || options?.keepNewest > 0);
}

function normalizeRuleNumber(value) {
  const number = Number.parseInt(value || "0", 10);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function currentTrashRuleValues() {
  return {
    olderThanDays: normalizeRuleNumber($("trashOlderThanDays")?.value),
    keepNewest: normalizeRuleNumber($("trashKeepNewest")?.value),
  };
}

function setTrashRuleValues(rule) {
  if (!rule) return;

  if ($("trashOlderThanDays")) {
    $("trashOlderThanDays").value = String(normalizeRuleNumber(rule.olderThanDays));
  }

  if ($("trashKeepNewest")) {
    $("trashKeepNewest").value = String(normalizeRuleNumber(rule.keepNewest));
  }

  if (typeof clearTrashPreviewResult === "function") {
    clearTrashPreviewResult();
  }

  if (typeof syncTrashRulePresetButtons === "function") {
    syncTrashRulePresetButtons();
  }
}

function selectedSendersSnapshotForRules() {
  return [...state.selected]
    .map(email => state.allSenders.find(sender => sender.email === email))
    .filter(Boolean);
}

function selectedCleanupRuleScope() {
  const senders = selectedSendersSnapshotForRules();
  if (senders.length === 0) return null;

  const domains = [...new Set(senders.map(sender => senderDomain(sender.email)).filter(Boolean))];

  if (senders.length === 1) {
    return {
      type: "sender",
      key: senders[0].email.toLowerCase(),
      label: senders[0].displayName || senders[0].email,
    };
  }

  if (domains.length === 1) {
    return {
      type: "domain",
      key: domains[0],
      label: domains[0],
    };
  }

  return {
    type: "selection",
    key: senders.map(sender => sender.email.toLowerCase()).sort().join("|"),
    label: `${senders.length} Absender`,
  };
}

function cleanupRuleStorageKey(scope) {
  if (!scope) return null;
  return `${scope.type}:${scope.key}`;
}

async function loadCleanupRules() {
  try {
    const data = await browser.storage.local.get(CLEANUP_RULES_KEY);
    const rules = data?.[CLEANUP_RULES_KEY];
    return rules && typeof rules === "object" ? rules : {};
  } catch (err) {
    console.warn("MailManager: Aufräum-Regeln konnten nicht geladen werden:", err);
    return {};
  }
}

async function saveCleanupRules(rules) {
  try {
    await browser.storage.local.set({ [CLEANUP_RULES_KEY]: rules || {} });
  } catch (err) {
    console.warn("MailManager: Aufräum-Regeln konnten nicht gespeichert werden:", err);
  }
}

async function migrateCleanupRulesToNormalizedDomains() {
  if (typeof loadCleanupRules !== "function" || typeof saveCleanupRules !== "function") {
    return;
  }

  const rules = await loadCleanupRules();
  let changed = false;

  for (const [key, rule] of Object.entries({ ...rules })) {
    if (!key.startsWith("domain:")) continue;

    const rawDomain = key.slice("domain:".length);
    const normalized = normalizeDomain(rawDomain);
    const normalizedKey = `domain:${normalized}`;

    if (!normalized || normalized === rawDomain || normalizedKey === key) {
      continue;
    }

    if (!rules[normalizedKey]) {
      rules[normalizedKey] = {
        ...rule,
        migratedFrom: key,
        updatedAt: rule.updatedAt || new Date().toISOString(),
      };
    }

    delete rules[key];
    changed = true;
  }

  if (changed) {
    await saveCleanupRules(rules);
  }
}

async function findCleanupRuleForCurrentSelection() {
  const scope = selectedCleanupRuleScope();
  if (!scope) return null;

  const rules = await loadCleanupRules();

  const exactKey = cleanupRuleStorageKey(scope);
  if (exactKey && rules[exactKey]) {
    return {
      scope,
      rule: rules[exactKey],
      source: "exact",
    };
  }

  const senders = selectedSendersSnapshotForRules();
  const domains = [...new Set(senders.map(sender => senderDomain(sender.email)).filter(Boolean))];

  if (domains.length === 1) {
    const domainScope = {
      type: "domain",
      key: domains[0],
      label: domains[0],
    };

    const domainKey = cleanupRuleStorageKey(domainScope);
    if (domainKey && rules[domainKey]) {
      return {
        scope: domainScope,
        rule: rules[domainKey],
        source: "domain",
      };
    }
  }

  return {
    scope,
    rule: null,
    source: "none",
  };
}

async function applyCleanupRuleForCurrentSelection() {
  const found = await findCleanupRuleForCurrentSelection();

  if (!found?.rule) {
    updateCleanupRuleInfo(found?.scope, null);
    return false;
  }

  setTrashRuleValues(found.rule);
  updateCleanupRuleInfo(found.scope, found.rule);
  return true;
}

async function saveCleanupRuleForCurrentSelection() {
  const scope = selectedCleanupRuleScope();

  if (!scope) {
    updateCleanupRuleInfo(null, null, "Keine Auswahl.");
    return;
  }

  const rule = {
    ...currentTrashRuleValues(),
    updatedAt: new Date().toISOString(),
  };

  const key = cleanupRuleStorageKey(scope);
  const rules = await loadCleanupRules();

  rules[key] = rule;

  await saveCleanupRules(rules);
  updateCleanupRuleInfo(scope, rule, "Regel gespeichert.");
}

function formatCleanupRule(rule) {
  if (!rule) return "";

  const parts = [];

  if (normalizeRuleNumber(rule.olderThanDays) > 0) {
    parts.push(`älter als ${normalizeRuleNumber(rule.olderThanDays)} Tage`);
  }

  if (normalizeRuleNumber(rule.keepNewest) > 0) {
    parts.push(`letzte ${normalizeRuleNumber(rule.keepNewest)} behalten`);
  }

  return parts.length ? parts.join(" · ") : "keine Regeln";
}

function updateCleanupRuleInfo(scope, rule, prefix = "") {
  const el = $("cleanupRuleInfo");
  if (!el) return;

  if (!scope) {
    el.textContent = prefix || "";
    return;
  }

  if (!rule) {
    el.textContent = `${prefix ? prefix + " " : ""}Keine gespeicherte Regel für ${scope.label}.`;
    return;
  }

  el.textContent =
    `${prefix ? prefix + " " : ""}Gespeicherte Regel für ${scope.label}: ${formatCleanupRule(rule)}.`;
}

function parseCleanupRuleStorageKey(storageKey) {
  const raw = String(storageKey || "");
  const separator = raw.indexOf(":");

  if (separator < 0) {
    return {
      type: "unknown",
      key: raw,
      label: raw,
    };
  }

  const type = raw.slice(0, separator);
  const key = raw.slice(separator + 1);

  return {
    type,
    key,
    label: key,
  };
}

function cleanupRuleTypeLabel(type) {
  switch (type) {
    case "sender":
      return _("viewSenders");
    case "domain":
      return "Domain";
    case "selection":
      return "Auswahl";
    default:
      return "Regel";
  }
}

function formatCleanupRuleUpdatedAt(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return _("statusUnknown");
  }

  return date.toLocaleString(browser.i18n.getUILanguage(), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderCleanupRuleManagerEntry(storageKey, rule) {
  const parsed = parseCleanupRuleStorageKey(storageKey);
  const ruleText = formatCleanupRule(rule);
  const updatedAt = formatCleanupRuleUpdatedAt(rule?.updatedAt);

  return `
    <div class="cleanup-rule-entry">
      <div class="cleanup-rule-entry-main">
        <div class="cleanup-rule-entry-title">
          <strong>${escapeHtml(cleanupRuleTypeLabel(parsed.type))}</strong>
          <span>${escapeHtml(parsed.label)}</span>
        </div>

        <div class="cleanup-rule-entry-rule">
          ${escapeHtml(ruleText)}
        </div>

        <div class="cleanup-rule-entry-meta">
          Aktualisiert: ${escapeHtml(updatedAt)}
        </div>
      </div>

      <div class="cleanup-rule-entry-actions">
        <button type="button" class="cleanup-rule-apply" data-rule-key="${escapeHtml(storageKey)}">
          Anwenden
        </button>
        <button type="button" class="cleanup-rule-delete danger" data-rule-key="${escapeHtml(storageKey)}">
          Löschen
        </button>
      </div>
    </div>
  `;
}

async function renderCleanupRuleManager() {
  const list = $("cleanupRuleManagerList");
  if (!list) return;

  const rules = await loadCleanupRules();
  const keys = Object.keys(rules).sort((a, b) => {
    const pa = parseCleanupRuleStorageKey(a);
    const pb = parseCleanupRuleStorageKey(b);

    const typeCompare = cleanupRuleTypeLabel(pa.type).localeCompare(cleanupRuleTypeLabel(pb.type), "de");
    if (typeCompare !== 0) return typeCompare;

    return pa.label.localeCompare(pb.label, "de");
  });

  if (keys.length === 0) {
    list.innerHTML = `
      <div class="cleanup-rule-empty">
${_("cleanupRuleManagerEmpty")}
      </div>
    `;
    return;
  }

  list.innerHTML = keys
    .map(key => renderCleanupRuleManagerEntry(key, rules[key]))
    .join("");

  list.querySelectorAll(".cleanup-rule-delete").forEach(button => {
    button.addEventListener("click", async () => {
      await deleteCleanupRuleByKey(button.dataset.ruleKey);
    });
  });

  list.querySelectorAll(".cleanup-rule-apply").forEach(button => {
    button.addEventListener("click", async () => {
      await applyCleanupRuleByKey(button.dataset.ruleKey);
    });
  });
}

async function openCleanupRuleManagerDialog() {
  await renderCleanupRuleManager();
  $("cleanupRuleManagerDialog").showModal();
}

async function deleteCleanupRuleByKey(storageKey) {
  if (!storageKey) return;

  const parsed = parseCleanupRuleStorageKey(storageKey);

  if (!confirm(_("cleanupRuleDeleteConfirm", [parsed.label]))) {
    return;
  }

  const rules = await loadCleanupRules();
  delete rules[storageKey];

  await saveCleanupRules(rules);
  await renderCleanupRuleManager();

  const found = await findCleanupRuleForCurrentSelection();
  updateCleanupRuleInfo(found?.scope, found?.rule || null);
}

async function applyCleanupRuleByKey(storageKey) {
  if (!storageKey) return;

  const rules = await loadCleanupRules();
  const rule = rules[storageKey];

  if (!rule) {
    await renderCleanupRuleManager();
    return;
  }

  setTrashRuleValues(rule);

  const parsed = parseCleanupRuleStorageKey(storageKey);
  $("cleanupRuleManagerDialog").close();

  const info = $("cleanupRuleInfo");
  if (info) {
    info.textContent =
      _("cleanupRuleApplied", [cleanupRuleTypeLabel(parsed.type), parsed.label, formatCleanupRule(rule)]);
  }
}

async function clearCleanupRulesWithConfirm() {
  const rules = await loadCleanupRules();
  const count = Object.keys(rules).length;

  if (count === 0) {
    await renderCleanupRuleManager();
    return;
  }

  if (!confirm(_("cleanupRuleClearConfirm", [count]))) {
    return;
  }

  await saveCleanupRules({});
  await renderCleanupRuleManager();

  const info = $("cleanupRuleInfo");
  if (info) {
    info.textContent = _("cleanupRuleClearSuccess");
  }
}

async function exportCleanupRules() {
  const rules = await loadCleanupRules();

  const payload = {
    exportedAt: new Date().toISOString(),
    app: "MailManager",
    type: "cleanupRules",
    version: 1,
    rules,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json;charset=utf-8",
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");

  a.href = url;
  a.download = `mailmanager-cleanup-rules-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();

  URL.revokeObjectURL(url);
}

function normalizeImportedCleanupRule(rule) {
  if (!rule || typeof rule !== "object") return null;

  const olderThanDays = normalizeRuleNumber(rule.olderThanDays);
  const keepNewest = normalizeRuleNumber(rule.keepNewest);

  return {
    olderThanDays,
    keepNewest,
    updatedAt: rule.updatedAt || new Date().toISOString(),
    importedAt: new Date().toISOString(),
  };
}

function normalizeImportedCleanupRulesPayload(payload) {
  const rawRules =
    payload?.type === "cleanupRules" && payload.rules && typeof payload.rules === "object"
      ? payload.rules
      : payload && typeof payload === "object"
        ? payload
        : null;

  if (!rawRules) {
    return {};
  }

  const normalized = {};

  for (const [key, rule] of Object.entries(rawRules)) {
    if (!String(key).includes(":")) continue;

    const parsed = parseCleanupRuleStorageKey(key);
    if (!["sender", "domain", "selection"].includes(parsed.type)) continue;

    const normalizedRule = normalizeImportedCleanupRule(rule);
    if (!normalizedRule) continue;

    normalized[key] = normalizedRule;
  }

  return normalized;
}

async function importCleanupRulesFromFile(event) {
  const input = event.target;
  const file = input?.files?.[0];

  if (!file) return;

  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    const importedRules = normalizeImportedCleanupRulesPayload(payload);
    const importedCount = Object.keys(importedRules).length;

    if (importedCount === 0) {
      alert(_("cleanup_import_invalid"));
      return;
    }

    const existingRules = await loadCleanupRules();
    const duplicateCount = Object.keys(importedRules)
      .filter(key => Object.prototype.hasOwnProperty.call(existingRules, key))
      .length;

    const ok = confirm(
      `${importedCount} Regel(n) importieren?\n\n` +
      `${duplicateCount} vorhandene Regel(n) werden überschrieben.\n` +
      `Alle anderen vorhandenen Regeln bleiben erhalten.`
    );

    if (!ok) return;

    const mergedRules = {
      ...existingRules,
      ...importedRules,
    };

    await saveCleanupRules(mergedRules);
    await renderCleanupRuleManager();

    if (typeof appendActionLog === "function") {
      await appendActionLog({
        type: "rules-import",
        accountId: $("accountSelect").value,
        accountName: currentAccountName(),
        folderId: $("folderSelect").value,
        folderName: currentFolderName(),
        senderCount: 0,
        inputMessageCount: 0,
        affectedMessageCount: importedCount,
        skippedCount: 0,
        sizeBytes: 0,
        options: { duplicateCount },
        undoable: false,
        senders: [],
      });
    }

    const found = await findCleanupRuleForCurrentSelection();
    updateCleanupRuleInfo(found?.scope, found?.rule || null, `${importedCount} Regel(n) importiert.`);
  } catch (err) {
    alert(_("cleanup_import_failed", [err.message]));
  } finally {
    if (input) input.value = "";
  }
}

function normalizeTrashRuleValue(value) {
  const number = Number.parseInt(value || "0", 10);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function setTrashRuleInputs(olderThanDays, keepNewest) {
  const older = $("trashOlderThanDays");
  const keep = $("trashKeepNewest");

  if (older) older.value = String(normalizeTrashRuleValue(olderThanDays));
  if (keep) keep.value = String(normalizeTrashRuleValue(keepNewest));

  clearTrashPreviewResult();
}

async function loadUiPrefs() {
  try {
    const res = await browser.storage.local.get(UI_PREFS_KEY);
    return res[UI_PREFS_KEY] && typeof res[UI_PREFS_KEY] === "object"
      ? res[UI_PREFS_KEY]
      : {};
  } catch {
    return {};
  }
}

async function saveUiPrefs(patch) {
  const current = await loadUiPrefs();
  const next = { ...current, ...patch };
  try {
    await browser.storage.local.set({ [UI_PREFS_KEY]: next });
  } catch {
    /* Speicherfehler ignorieren — reine UI-Präferenz */
  }
}

async function saveTrashRulePrefs() {
  const prefs = {
    olderThanDays: normalizeTrashRuleValue($("trashOlderThanDays")?.value),
    keepNewest: normalizeTrashRuleValue($("trashKeepNewest")?.value),
    savedAt: new Date().toISOString(),
  };

  try {
    await browser.storage.local.set({ [TRASH_RULE_PREF_KEY]: prefs });
  } catch (err) {
    console.warn("MailManager: Aufräum-Regeln konnten nicht gespeichert werden:", err);
  }
}

async function loadTrashRulePrefs() {
  try {
    const data = await browser.storage.local.get(TRASH_RULE_PREF_KEY);
    const prefs = data?.[TRASH_RULE_PREF_KEY];

    if (!prefs) {
      return {
        olderThanDays: 0,
        keepNewest: 0,
      };
    }

    return {
      olderThanDays: normalizeTrashRuleValue(prefs.olderThanDays),
      keepNewest: normalizeTrashRuleValue(prefs.keepNewest),
    };
  } catch (err) {
    console.warn("MailManager: Aufräum-Regeln konnten nicht geladen werden:", err);
    return {
      olderThanDays: 0,
      keepNewest: 0,
    };
  }
}

async function applySavedTrashRulePrefs() {
  const prefs = await loadTrashRulePrefs();
  setTrashRuleInputs(prefs.olderThanDays, prefs.keepNewest);
}

function bindTrashRulePresets() {
  document.querySelectorAll(".trash-rule-preset").forEach(btn => {
    btn.addEventListener("click", async () => {
      const older = btn.dataset.older || "0";
      const keep = btn.dataset.keep || "0";

      setTrashRuleInputs(older, keep);
      await saveTrashRulePrefs();
      syncTrashRulePresetButtons();
    });
  });
}

function syncTrashRulePresetButtons() {
  const older = normalizeTrashRuleValue($("trashOlderThanDays")?.value);
  const keep = normalizeTrashRuleValue($("trashKeepNewest")?.value);

  document.querySelectorAll(".trash-rule-preset").forEach(btn => {
    const btnOlder = normalizeTrashRuleValue(btn.dataset.older);
    const btnKeep = normalizeTrashRuleValue(btn.dataset.keep);

    btn.classList.toggle("active", older === btnOlder && keep === btnKeep);
  });
}

let trashPreviewRequestId = 0;

function setTrashPreviewResult(html, warning = false, reveal = false) {
  const box = $("trashPreviewResult");
  if (!box) return;

  box.hidden = false;
  box.classList.toggle("warning", warning);
  box.innerHTML = html;
  if (reveal) box.scrollIntoView({ block: "center" });
}

function clearTrashPreviewResult() {
  trashPreviewRequestId += 1;
  const box = $("trashPreviewResult");
  if (!box) return;

  box.hidden = true;
  box.classList.remove("warning");
  box.innerHTML = "";
  $("confirmOk").dataset.previewReady = "false";
  const btn = $("trashPreviewBtn");
  if (btn) {
    btn.disabled = false;
    btn.textContent = _("previewBtn");
  }
  updateTrashConfirmState();
}

async function previewTrashAction() {
  const requestId = ++trashPreviewRequestId;
  const messageIds = selectedMessageIds();
  if (messageIds.length === 0) return;

  const options = readTrashRules();
  const btn = $("trashPreviewBtn");

  if (btn) {
    btn.disabled = true;
    btn.textContent = _("previewCalculating");
  }

  setTrashPreviewResult(_("previewBeingCalculated"));

  try {
    const response = await browser.runtime.sendMessage({
      action: "previewTrash",
      messageIds,
      options,
    });

    if (!isCurrentPreviewRequest(requestId, trashPreviewRequestId)) return;

    if (response?.error) {
      throw new Error(response.error);
    }

    const moveCount = response?.moveCount || 0;
    const skippedCount = response?.skippedCount || 0;
    const totalInputCount = response?.totalInputCount ?? messageIds.length;
    const moveSize = formatSize(response?.moveSizeBytes || 0);

    const samples = (response?.sampleSubjects || [])
      .slice(0, 5)
      .map(subject => `<li>${escapeHtml(subject)}</li>`)
      .join("");

    const warning = moveCount === 0;

    $("confirmOk").dataset.previewReady = String(moveCount > 0);
    updateTrashConfirmState();

    setTrashPreviewResult(`
      <div><strong>${moveCount}</strong> von ${totalInputCount} Mails würden verschoben.</div>
      <div><strong>${skippedCount}</strong> Mails bleiben durch Aufräum-Regeln erhalten.</div>
      <div>Geschätzte Größe: <strong>${moveSize}</strong></div>
      ${samples ? `<div style="margin-top:.5rem">Neueste Beispiele:</div><ul>${samples}</ul>` : ""}
    `, warning, true);
  } catch (err) {
    if (!isCurrentPreviewRequest(requestId, trashPreviewRequestId)) return;
    $("confirmOk").dataset.previewReady = "false";
    updateTrashConfirmState();
    setTrashPreviewResult(`Vorschau fehlgeschlagen: ${escapeHtml(err.message)}`, true, true);
  } finally {
    if (btn && isCurrentPreviewRequest(requestId, trashPreviewRequestId)) {
      btn.disabled = false;
      btn.textContent = _("previewBtn");
    }
  }
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName?.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
}

function isRowControlTarget(el) {
  return Boolean(el?.closest?.("button,input,select,textarea,a,label"));
}

function getSenderByEmail(email) {
  return state.allSenders.find(s => s.email === email) || null;
}


function domainEntryByName(domainName) {
  return state.filteredDomains.find(d => d.domain === domainName)
    || getDomainGroups(state.allSenders).find(d => d.domain === domainName)
    || null;
}

function selectOnlyDomain(domainName) {
  const domain = domainEntryByName(domainName);
  if (!domain) return false;

  state.selected.clear();

  for (const sender of domain.senders) {
    if (state.protectedEmails.has(sender.email)) continue;
    state.selected.add(sender.email);
  }

  state.lastSelectedEmail = null;

  renderSenders();
  updateSelectionLabel();
  updateActionButtons();
  syncSelectAll();
  updateCleanupAssistant();

  return state.selected.size > 0;
}

async function openTrashDialogForDomain(domainName) {
  const selected = selectOnlyDomain(domainName);

  if (!selected) {
    showError(`Keine auswählbaren Absender für Domain ${domainName}.`);
    return;
  }

  await openConfirmDialog("trash");
}

async function openTrashDialogForDomainRule(domainName) {
  const selected = selectOnlyDomain(domainName);

  if (!selected) {
    showError(`Keine auswählbaren Absender für Domain ${domainName}.`);
    return;
  }

  if (typeof applyCleanupRuleForCurrentSelection === "function") {
    await applyCleanupRuleForCurrentSelection();
  }

  await openConfirmDialog("trash");
}

function selectedSendersForRuleSuggestion() {
  return [...state.selected]
    .map(email => state.allSenders.find(sender => sender.email === email))
    .filter(Boolean);
}

function selectedSuggestionStats() {
  const senders = selectedSendersForRuleSuggestion();
  const senderCount = senders.length;
  const mailCount = senders.reduce((sum, sender) => sum + (sender.count || 0), 0);
  const sizeBytes = senders.reduce((sum, sender) => sum + (sender.totalSizeBytes || 0), 0);

  const bulkCount = senders.filter(sender => sender.isBulkCandidate).length;
  const unsubscribeCount = senders.filter(sender => sender.hasUnsubscribe).length;
  const inactiveCount = senders.filter(sender => isInactiveForDays(sender.newestDate, 365)).length;
  const highScoreCount = senders.filter(sender => (sender.riskScore || 0) >= 70).length;

  return {
    senders,
    senderCount,
    mailCount,
    sizeBytes,
    bulkRate: senderCount > 0 ? bulkCount / senderCount : 0,
    unsubscribeRate: senderCount > 0 ? unsubscribeCount / senderCount : 0,
    inactiveRate: senderCount > 0 ? inactiveCount / senderCount : 0,
    highScoreRate: senderCount > 0 ? highScoreCount / senderCount : 0,
  };
}

function suggestCleanupRuleForCurrentSelection() {
  const stats = selectedSuggestionStats();

  if (stats.senderCount === 0) {
    return null;
  }

  if (stats.bulkRate >= 0.7 || stats.unsubscribeRate >= 0.5) {
    return {
      olderThanDays: 90,
      keepNewest: 3,
      title: "Newsletter/Bulk-Auswahl",
      reason:
        "Viele ausgewählte Absender sehen nach Newsletter, Shops oder Benachrichtigungen aus. " +
        "Für solche Mails ist ein kürzerer Zeitraum meist sinnvoll.",
    };
  }

  if (stats.inactiveRate >= 0.7) {
    return {
      olderThanDays: 365,
      keepNewest: 1,
      title: "Inaktive Absender",
      reason:
        "Die meisten ausgewählten Absender waren länger als ein Jahr inaktiv. " +
        "Die neueste Mail pro Absender bleibt zur Orientierung erhalten.",
    };
  }

  if (stats.sizeBytes >= 500 * 1024 * 1024) {
    return {
      olderThanDays: 365,
      keepNewest: 5,
      title: _("cleanupAssistantStorageTitle"),
      reason:
        "Die Auswahl belegt viel Speicherplatz. Alte Mails werden aufgeräumt, " +
        "die letzten 5 Mails pro Absender bleiben erhalten.",
    };
  }

  if (stats.highScoreRate >= 0.5 || stats.mailCount >= 500) {
    return {
      olderThanDays: 365,
      keepNewest: 5,
      title: "Große Aufräum-Auswahl",
      reason:
        "Die Auswahl enthält viele Mails oder hohe Aufräum-Scores. " +
        "Ein konservativer Jahresfilter schützt aktuelle Kommunikation.",
    };
  }

  return {
    olderThanDays: 365,
    keepNewest: 5,
    title: "Sicherer Standard",
    reason:
      "Konservativer Vorschlag: Nur ältere Mails verschieben und die letzten 5 pro Absender behalten.",
  };
}

function ensureTrashRuleSuggestionBox() {
  if ($("trashRuleSuggestion")) return;

  const ruleBox = $("trashRuleBox");
  if (!ruleBox) return;

  const box = document.createElement("div");
  box.id = "trashRuleSuggestion";
  box.className = "trash-rule-suggestion";
  box.hidden = true;
  box.innerHTML = `
    <div class="trash-rule-suggestion-title"></div>
    <div class="trash-rule-suggestion-text"></div>
    <button id="applyTrashRuleSuggestion" type="button">Vorschlag übernehmen</button>
  `;

  const previewActions = ruleBox.querySelector(".trash-preview-actions");
  if (previewActions) {
    previewActions.insertAdjacentElement("beforebegin", box);
  } else {
    ruleBox.appendChild(box);
  }

  $("applyTrashRuleSuggestion")?.addEventListener("click", async () => {
    const suggestion = suggestCleanupRuleForCurrentSelection();
    if (!suggestion) return;

    setTrashRuleValues(suggestion);

    if (typeof saveTrashRulePrefs === "function") {
      await saveTrashRulePrefs();
    }

    updateTrashRuleSuggestion();
    renderTrashSafetyWarnings();
  });
}

function updateTrashRuleSuggestion() {
  ensureTrashRuleSuggestionBox();

  const box = $("trashRuleSuggestion");
  if (!box) return;

  const suggestion = suggestCleanupRuleForCurrentSelection();

  if (!suggestion) {
    box.hidden = true;
    return;
  }

  box.hidden = false;

  const title = box.querySelector(".trash-rule-suggestion-title");
  const text = box.querySelector(".trash-rule-suggestion-text");

  if (title) {
    title.textContent =
      `Vorschlag: ${suggestion.title} — älter als ${suggestion.olderThanDays} Tage, letzte ${suggestion.keepNewest} behalten`;
  }

  if (text) {
    text.textContent = suggestion.reason;
  }
}

function getFocusedSenderEntry() {
  const row = document.activeElement?.closest?.(".sender-row");
  if (!row?.dataset?.email) return null;
  return getSenderByEmail(row.dataset.email);
}

function getFirstSelectedSenderEntry() {
  for (const sender of state.filteredSenders) {
    if (state.selected.has(sender.email)) return sender;
  }
  return null;
}

function selectSenderRange(fromEmail, toEmail, checked) {
  const fromIndex = state.filteredSenders.findIndex(s => s.email === fromEmail);
  const toIndex = state.filteredSenders.findIndex(s => s.email === toEmail);

  if (fromIndex < 0 || toIndex < 0) {
    toggleRowSelect(toEmail, checked);
    state.lastSelectedEmail = toEmail;
    return;
  }

  const start = Math.min(fromIndex, toIndex);
  const end = Math.max(fromIndex, toIndex);

  for (const sender of state.filteredSenders.slice(start, end + 1)) {
    if (state.protectedEmails.has(sender.email)) continue;
    if (checked) state.selected.add(sender.email);
    else state.selected.delete(sender.email);
  }

  state.lastSelectedEmail = toEmail;
  renderSenders();
  updateActionButtons();
}

function handleSenderRowClick(entry, event) {
  if (isRowControlTarget(event.target)) return;
  if (state.protectedEmails.has(entry.email)) return;

  const row = findRow(entry.email);
  row?.focus?.({ preventScroll: true });

  const checked = !state.selected.has(entry.email);

  if (event.shiftKey && state.lastSelectedEmail) {
    selectSenderRange(state.lastSelectedEmail, entry.email, checked);
    return;
  }

  toggleRowSelect(entry.email, checked);
  state.lastSelectedEmail = entry.email;
}

async function handleKeyboardShortcuts(event) {
  // Entf/Delete vor den Control-Guards behandeln: eine fokussierte Auswahl-
  // Checkbox ist kein Texteingabefeld und darf den Papierkorb-Shortcut nicht
  // blockieren. In echten Textfeldern bleibt Entf dem Feld vorbehalten.
  if (event.key === "Delete"
      && !isTextEntryTarget(event.target)
      && !document.querySelector("dialog[open]")
      && !state.activeScanId) {
    if (state.selected.size === 0 && state.selectedMessages.size === 0) return;
    event.preventDefault();
    await dispatchAction("trash");
    return;
  }

  if (isTypingTarget(event.target)) return;
  if (isRowControlTarget(event.target)) return;
  if (document.querySelector("dialog[open]")) return;
  if (state.activeScanId) return;

  const focusedMessageRow = document.activeElement?.classList?.contains("message-row")
    ? document.activeElement
    : null;

  const focusedRow = document.activeElement?.closest?.(ROW_SELECTOR) || null;

  if (focusedRow && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    event.preventDefault();
    const rows = [...$("senderList").querySelectorAll(ROW_SELECTOR)];
    const idx = rows.indexOf(focusedRow);
    const next = event.key === "ArrowDown" ? rows[idx + 1] : rows[idx - 1];
    if (next) {
      setActiveRow(next);
      next.focus();
      next.scrollIntoView({ block: "nearest" });
    }
    return;
  }

  if (focusedMessageRow && (event.key === " " || event.code === "Space")) {
    event.preventDefault();
    const id = Number(focusedMessageRow.dataset.messageId);
    const senderEmail = focusedMessageRow.dataset.senderEmail;
    const bucket = state.senderMessages.get(senderEmail);
    const meta = bucket?.metas.find(m => m.id === id);
    if (meta) toggleMessagePreview(meta);
    return;
  }

  if (event.key === "Enter" || event.key === " " || event.code === "Space") {
    const entry = getFocusedSenderEntry() || getFirstSelectedSenderEntry();
    if (!entry) return;

    event.preventDefault();
    await openSenderMessage(entry);
  }
}

// ─── Confirm dialog (trash) ───────────────────────────────────────────────────
async function openConfirmDialog(actionType) {
  const sel = state.filteredSenders.filter(s => state.selected.has(s.email));
  const byteCount = sel.reduce((n, e) => n + e.totalSizeBytes, 0);

  const senderCount = state.selected.size;
  const individualCount = state.selectedMessages.size;
  const totalMailCount = selectedMessageIds().length;

  const isTrash = actionType === "trash";
  const label = "in den Papierkorb verschieben";

  let message;
  if (senderCount > 0 && individualCount > 0) {
    message =
      `${totalMailCount} Mails (${senderCount} Absender + ${individualCount} einzeln gewählte) ${label}?`;
  } else if (senderCount > 0) {
    message =
      `${totalMailCount} Mails von ${senderCount} Absender(n) ${label}? ` +
      `Gesamtgröße: ${formatSize(byteCount)}.`;
  } else {
    message = `${individualCount} einzeln ausgewählte Mail(s) ${label}?`;
  }

  $("confirmMessage").textContent = message;

  const ruleBox = $("trashRuleBox");
  if (ruleBox) {
    ruleBox.hidden = !isTrash;
  }

  if (isTrash) {
    if (typeof applySavedTrashRulePrefs === "function") {
      await applySavedTrashRulePrefs();
    } else {
      $("trashOlderThanDays").value = $("trashOlderThanDays").value || "0";
      $("trashKeepNewest").value = $("trashKeepNewest").value || "0";
    }

    if (typeof syncTrashRulePresetButtons === "function") {
      syncTrashRulePresetButtons();
    }

    if (typeof applyCleanupRuleForCurrentSelection === "function") {
      await applyCleanupRuleForCurrentSelection();
    }

    updateTrashRuleSuggestion();
  }

  if (typeof clearTrashPreviewResult === "function") {
    clearTrashPreviewResult();
  }

  const dialog = $("confirmDialog");

  if (isTrash) {
    renderTrashSafetyWarnings();
  } else if ($("trashSafetyBox")) {
    $("trashSafetyBox").hidden = true;
  }

  dialog.showModal();

  const ok = $("confirmOk");
  const can = $("confirmCancel");
  const preview = $("trashPreviewBtn");
  const olderInput = $("trashOlderThanDays");
  const keepInput = $("trashKeepNewest");

  const onRulesChanged = async () => {
    if (typeof clearTrashPreviewResult === "function") {
      clearTrashPreviewResult();
    }

    if (typeof syncTrashRulePresetButtons === "function") {
      syncTrashRulePresetButtons();
    }

    if (typeof saveTrashRulePrefs === "function") {
      await saveTrashRulePrefs();
    }

    if (typeof findCleanupRuleForCurrentSelection === "function") {
      const found = await findCleanupRuleForCurrentSelection();
      updateCleanupRuleInfo(found?.scope, found?.rule || null);
    }

    updateTrashRuleSuggestion();
    renderTrashSafetyWarnings();
  };

  const cleanup = () => {
    ok.removeEventListener("click", onOk);
    can.removeEventListener("click", onCan);
    preview?.removeEventListener("click", onPreview);
    olderInput?.removeEventListener("input", onRulesChanged);
    keepInput?.removeEventListener("input", onRulesChanged);
  };

  const onOk = async () => {
    cleanup();
    dialog.close();

    const options = isTrash ? readTrashRules() : {};

    if (isTrash) {
      await saveTrashRulePrefs();
    }

    await dispatchAction(actionType, options);
  };

  const onCan = () => {
    cleanup();
    dialog.close();
  };

  const onPreview = async () => {
    await previewTrashAction();
  };

  ok.addEventListener("click", onOk);
  can.addEventListener("click", onCan);
  preview?.addEventListener("click", onPreview);
  olderInput?.addEventListener("input", onRulesChanged);
  keepInput?.addEventListener("input", onRulesChanged);

  if (isTrash) await previewTrashAction();
}

function actionTypeLabel(type) {
  switch (type) {
    case "trash":
      return _("action_trash");

    case "folder":
      return _("actionFolder");
    case "tag":
      return "Tag";
    case "unsubscribe":
      return _("actionUnsubscribe");
    case "undo":
      return _("actionUndo");
    case "rules-import":
      return _("actionRulesImport");
    default:
      return type || "Aktion";
  }
}

function currentAccountName() {
  const accountId = $("accountSelect").value;
  const account = state.accounts.find(a => a.id === accountId);
  return account?.name || accountId || "";
}

function currentFolderName() {
  const folderId = $("folderSelect").value;
  const account = state.accounts.find(a => a.id === $("accountSelect").value);
  const folder = account?.folders?.find(f => f.id === folderId);
  return folder?.name || folderId || "";
}

function selectedSenderSnapshot() {
  return [...state.selected].map(email => {
    const sender = state.allSenders.find(s => s.email === email);

    return {
      email,
      displayName: sender?.displayName || email,
      count: sender?.count || 0,
      totalSizeBytes: sender?.totalSizeBytes || 0,
      newestDate: sender?.newestDate instanceof Date
        ? sender.newestDate.toISOString()
        : sender?.newestDate || null,
    };
  });
}

function compactActionOptions(options = {}) {
  const compact = {};

  if (options.olderThanDays) compact.olderThanDays = options.olderThanDays;
  if (options.keepNewest) compact.keepNewest = options.keepNewest;
  if (options.folderName) compact.folderName = options.folderName;
  if (options.existingFolderId) compact.existingFolderId = options.existingFolderId;
  if (options.parentFolderId) compact.parentFolderId = options.parentFolderId;
  if (options.tagKey) compact.tagKey = options.tagKey;

  return compact;
}

async function loadActionLog() {
  try {
    const data = await browser.storage.local.get(ACTION_LOG_KEY);
    const entries = data?.[ACTION_LOG_KEY];

    return Array.isArray(entries) ? entries : [];
  } catch (err) {
    console.warn("MailManager: Aktionsprotokoll konnte nicht geladen werden:", err);
    return [];
  }
}

async function saveActionLog(entries) {
  const safeEntries = Array.isArray(entries)
    ? entries.slice(0, ACTION_LOG_LIMIT)
    : [];

  try {
    await browser.storage.local.set({ [ACTION_LOG_KEY]: safeEntries });
  } catch (err) {
    console.warn("MailManager: Aktionsprotokoll konnte nicht gespeichert werden:", err);
  }
}

async function appendActionLog(entry) {
  const entries = await loadActionLog();

  entries.unshift({
    id: `log-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    ...entry,
  });

  await saveActionLog(entries);
}

async function loadColumnVisibility() {
  try {
    const data = await browser.storage.local.get(COLUMN_VISIBILITY_KEY);
    const saved = data?.[COLUMN_VISIBILITY_KEY];
    return { ...DEFAULT_COLUMN_VISIBILITY, ...saved };
  } catch (err) {
    console.warn("MailManager: Spaltensichtbarkeit konnte nicht geladen werden:", err);
    return DEFAULT_COLUMN_VISIBILITY;
  }
}

async function saveColumnVisibility(visibility) {
  try {
    await browser.storage.local.set({ [COLUMN_VISIBILITY_KEY]: visibility });
  } catch (err) {
    console.warn("MailManager: Spaltensichtbarkeit konnte nicht gespeichert werden:", err);
  }
}

function applyColumnVisibility(visibility) {
  for (const [colId, isVisible] of Object.entries(visibility)) {
    const elements = document.querySelectorAll(`.${colId}`);
    elements.forEach(el => {
      el.style.display = isVisible ? "" : "none";
    });
  }
}

async function initializeColumnDialog() {
  const visibility = await loadColumnVisibility();
  const container = $("columnCheckboxes");

  if (!container) return;

  container.innerHTML = "";

  for (const { id, label } of CONFIGURABLE_COLUMNS) {
    const item = document.createElement("div");
    item.className = "column-checkbox-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = `column-${id}`;
    checkbox.checked = visibility[id] ?? true;
    checkbox.addEventListener("change", async e => {
      visibility[id] = e.target.checked;
      await saveColumnVisibility(visibility);
      applyColumnVisibility(visibility);
    });

    const labelEl = document.createElement("label");
    labelEl.htmlFor = `column-${id}`;
    labelEl.textContent = label;

    item.appendChild(checkbox);
    item.appendChild(labelEl);
    container.appendChild(item);
  }

  applyColumnVisibility(visibility);
}

async function resetColumnVisibility() {
  await saveColumnVisibility(DEFAULT_COLUMN_VISIBILITY);
  await initializeColumnDialog();
}

function formatActionLogDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return _("statusUnknown");

  return date.toLocaleString(browser.i18n.getUILanguage(), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderActionLogEntry(entry) {
  const senderPreview = (entry.senders || [])
    .slice(0, 5)
    .map(sender => escapeHtml(sender.displayName || sender.email))
    .join(", ");

  const more =
    (entry.senders || []).length > 5
      ? ` +${entry.senders.length - 5} weitere`
      : "";

  const rules = [];

  if (entry.options?.olderThanDays) {
    rules.push(`älter als ${entry.options.olderThanDays} Tage`);
  }

  if (entry.options?.keepNewest) {
    rules.push(`letzte ${entry.options.keepNewest} behalten`);
  }

  if (entry.options?.folderName) {
    rules.push(`Zielordner: ${entry.options.folderName}`);
  }

  if (entry.options?.tagKey) {
    rules.push(`Tag: ${entry.options.tagKey}`);
  }

  return `
    <div class="action-log-entry">
      <div class="action-log-entry-head">
        <strong>${escapeHtml(actionTypeLabel(entry.type))}</strong>
        <span>${escapeHtml(formatActionLogDate(entry.createdAt))}</span>
      </div>

      <div class="action-log-entry-main">
        ${entry.senderCount || 0} Absender ·
        ${entry.inputMessageCount || 0} ausgewählte Mails ·
        ${entry.affectedMessageCount || 0} betroffen
        ${entry.skippedCount ? ` · ${entry.skippedCount} behalten` : ""}
        ${entry.sizeBytes ? ` · ${formatSize(entry.sizeBytes)}` : ""}
      </div>

      <div class="action-log-entry-sub">
        Konto: ${escapeHtml(entry.accountName || "")} ·
        Ordner: ${escapeHtml(entry.folderName || "")}
      </div>

      ${rules.length ? `<div class="action-log-entry-rules">${_("actionLogRules", [escapeHtml(rules.join(" · "))])}</div>` : ""}
      ${senderPreview ? `<div class="action-log-entry-senders">${_("actionLog_senders", [senderPreview + more])}</div>` : ""}
      ${entry.undoable ? `<div class="action-log-entry-undo">${_("actionLogUndoAvailable")}</div>` : ""}
    </div>
  `;
}

async function renderActionLog() {
  const list = $("actionLogList");
  if (!list) return;

  const entries = await loadActionLog();

  if (entries.length === 0) {
    list.innerHTML = `<div class="action-log-empty">${_("actionLog_empty")}</div>`;
    return;
  }

  list.innerHTML = entries.map(renderActionLogEntry).join("");
}

async function openActionLogDialog() {
  await renderActionLog();
  $("actionLogDialog").showModal();
}

async function clearActionLogWithConfirm() {
  if (!confirm("Aktionsprotokoll wirklich leeren?")) return;

  await saveActionLog([]);
  await renderActionLog();
}

async function exportActionLog() {
  const entries = await loadActionLog();

  const blob = new Blob([JSON.stringify(entries, null, 2)], {
    type: "application/json;charset=utf-8",
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");

  a.href = url;
  a.download = `mailmanager-action-log-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();

  URL.revokeObjectURL(url);
}

// ─── Dispatch action to background ────────────────────────────────────────────
// messageIdsOverride: explizite Mail-Liste (z. B. Drag & Drop), die NICHT aus
// der aktuellen Auswahl stammt. Erzwingt einen vollständigen Rescan danach,
// weil der Absender-Schnellpfad die Auswahl nicht widerspiegeln würde.
async function dispatchAction(type, options = {}, messageIdsOverride = null) {
  const accountId = $("accountSelect").value;
  const folderId = $("folderSelect").value;
  const messageIds = messageIdsOverride || selectedMessageIds();
  const senderSnapshot = messageIdsOverride ? [] : selectedSenderSnapshot();

  if (messageIds.length === 0) return;

  let response;
  try {
    response = await browser.runtime.sendMessage({
      action: "performAction",
      type,
      messageIds,
      accountId,
      folderId,
      options,
    });
  } catch (err) {
    showError(_("errorActionFailed", [err.message || "Verbindungsfehler"]));
    return;
  }

  if (response?.error) {
    showError(response.error);
    return;
  }

  const usedPartialTrashRules =
    type === "trash" && hasActiveTrashRules(options);

  const affectedMessageCount =
    response?.movedCount ??
    response?.affectedMessageCount ??
    messageIds.length;

  const skippedCount = response?.skippedCount || 0;

  await appendActionLog({
    type,
    accountId,
    accountName: currentAccountName(),
    folderId,
    folderName: currentFolderName(),
    senderCount: senderSnapshot.length,
    inputMessageCount: messageIds.length,
    affectedMessageCount,
    skippedCount,
    sizeBytes: senderSnapshot.reduce((sum, sender) => sum + (sender.totalSizeBytes || 0), 0),
    options: compactActionOptions(options),
    undoable: Boolean(response?.undoable),
    senders: senderSnapshot.slice(0, 100),
  });

  // Teil-Fehlschlag (einzelne veraltete IDs) sichtbar melden — sonst bliebe
  // unklar, warum nach der Aktion noch Mails übrig sind.
  if (response?.failedCount > 0) {
    const affected = response.movedCount ?? response.taggedCount ?? response.markedCount ?? 0;
    const actionLabel = type === "tag" ? _("partialActionTagged") : type === "markAsRead" ? _("partialActionRead") : _("partialActionMoved");
    alert(_("partialActionFailure", [affected, actionLabel, response.failedCount]));
  }

  // Der Schnellpfad unten entfernt ganze Absender aus state.allSenders. Das ist
  // nur korrekt, wenn ausschließlich Absender ausgewählt waren. Bei Einzelmail-
  // Auswahl, Drag & Drop oder Teil-Aufräum-Regeln bleibt der Absender bestehen —
  // daher ein vollständiger Rescan, der den Zustand zuverlässig neu aufbaut.
  const needsRescan =
    usedPartialTrashRules || state.selectedMessages.size > 0 || Boolean(messageIdsOverride)
    || response?.failedCount > 0 || type === "tag" || type === "markAsRead";

  if (needsRescan) {
    if (usedPartialTrashRules) {
      const moved = response?.movedCount ?? 0;
      const skipped = response?.skippedCount ?? 0;

      $("statsLabel").textContent =
        `${moved} Mails verschoben · ${skipped} durch Aufräum-Regeln behalten`;
    }

    state.selected.clear();
    state.selectedMessages.clear();
    updateActionButtons();
    updateSelectionLabel();

    if (response.undoable) showUndoToast();

    await startScan();
    return;
  }

  state.allSenders = state.allSenders.filter(s => !state.selected.has(s.email));
  state.selected.clear();
  state.selectedMessages.clear();
  updateStatsLabel();
  applyFilter();
  updateActionButtons();
  updateCleanupAssistant();
  updateCleanupDashboard();
  scheduleFeatureStatusUpdate();

  if (response.undoable) showUndoToast();
}

// ─── Folder dialog ────────────────────────────────────────────────────────────
function openFolderDialog() {
  const firstEmail = [...state.selected][0];
  const entry = state.allSenders.find(e => e.email === firstEmail);
  $("folderNameInput").value = entry?.displayName || "";

  const account = state.accounts.find(a => a.id === $("accountSelect").value);
  const folders = account?.folders || [];
  const parentSel = $("parentFolderSelect"), existingSel = $("existingFolderSelect");
  parentSel.innerHTML   = '<option value="">Konto-Root</option>';
  existingSel.innerHTML = '<option value="">Neuen Ordner erstellen</option>';
  for (const f of folders) {
    const o1 = document.createElement("option"); o1.value = f.id; o1.textContent = f.name; parentSel.appendChild(o1);
    const o2 = document.createElement("option"); o2.value = f.id; o2.textContent = f.name; existingSel.appendChild(o2);
  }

  const dialog = $("folderDialog");
  dialog.showModal();
  const ok = $("folderOk"), can = $("folderCancel");
  const cleanup = () => { ok.removeEventListener("click", onOk); can.removeEventListener("click", onCan); };
  const onCan = () => { cleanup(); dialog.close(); };
  const onOk  = async () => {
    cleanup(); dialog.close();
    const existingId = existingSel.value;
    const options = existingId
      ? { existingFolderId: existingId }
      : { folderName: $("folderNameInput").value.trim(), parentFolderId: parentSel.value || null };
    await dispatchAction("folder", options);
  };
  ok.addEventListener("click", onOk);
  can.addEventListener("click", onCan);
}

// ─── Drag & Drop: Mails/Absender in Ordner ablegen ────────────────────────────

/**
 * Ermittelt die Mail-IDs, die beim Ziehen einer Zeile verschoben werden sollen.
 * Wird eine bereits ausgewählte Zeile gezogen, gilt die gesamte Auswahl;
 * sonst nur das gezogene Element.
 */
function resolveDragMessageIds(row) {
  if (row.classList.contains("message-row")) {
    const id = Number(row.dataset.messageId);
    if (state.selectedMessages.has(String(id))) return selectedMessageIds();
    return Number.isFinite(id) ? [id] : [];
  }

  const email = row.dataset.email;
  if (!email) return [];

  if (state.selected.has(email)) return selectedMessageIds();

  const sender = state.allSenders.find(s => s.email === email);
  return sender ? [...sender.messageIds] : [];
}

/** Füllt das Drop-Overlay mit den Ordnern des aktuellen Kontos (ohne Quellordner). */
function populateDropFolderOverlay() {
  const account = state.accounts.find(a => a.id === $("accountSelect").value);
  const currentFolderId = $("folderSelect").value;
  const list = $("dropFolderList");
  if (!list) return;

  list.innerHTML = "";

  const folders = (account?.folders || []).filter(f => f.id !== currentFolderId);

  if (folders.length === 0) {
    const empty = document.createElement("div");
    empty.className = "drop-folder-empty";
    empty.textContent = _("folderNoOtherAvailable");
    list.appendChild(empty);
    return;
  }

  for (const folder of folders) {
    const item = document.createElement("div");
    item.className = "drop-folder-target";
    item.dataset.folderId = folder.id;
    item.textContent = folder.name + (folder.protected ? " 🛡" : "");
    list.appendChild(item);
  }
}

function onRowDragStart(event) {
  const row = event.target.closest(".message-row, .sender-row");
  if (!row || row.classList.contains("domain-row")) return;

  const ids = resolveDragMessageIds(row);
  if (ids.length === 0) {
    event.preventDefault();
    return;
  }

  state.dragMessageIds = ids;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", `mailmanager:${ids.length}`);
  row.classList.add("dragging");

  populateDropFolderOverlay();
  $("dropFolderOverlay").hidden = false;
}

function onRowDragEnd(event) {
  const row = event.target.closest(".message-row, .sender-row");
  if (row) row.classList.remove("dragging");

  $("dropFolderOverlay").hidden = true;
  state.dragMessageIds = null;
}

function onDropOverlayDragOver(event) {
  const target = event.target.closest(".drop-folder-target");
  if (!target) return;

  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  target.classList.add("drag-over");
}

function onDropOverlayDragLeave(event) {
  const target = event.target.closest(".drop-folder-target");
  if (target && !target.contains(event.relatedTarget)) {
    target.classList.remove("drag-over");
  }
}

async function onDropOverlayDrop(event) {
  const target = event.target.closest(".drop-folder-target");
  if (!target) return;

  event.preventDefault();
  target.classList.remove("drag-over");

  const folderId = target.dataset.folderId;
  // dragend setzt state.dragMessageIds danach auf null — daher lokal sichern.
  const messageIds = state.dragMessageIds;
  $("dropFolderOverlay").hidden = true;

  if (folderId && messageIds && messageIds.length > 0) {
    await dispatchAction("folder", { existingFolderId: folderId }, messageIds);
  }
}

// ─── Tag dialog ───────────────────────────────────────────────────────────────
async function openTagDialog() {
  const tags = await browser.messages.tags.list();
  const list = $("tagList");
  list.innerHTML = "";
  for (const tag of tags) {
    const item = document.createElement("div");
    item.className = "tag-item";
    item.innerHTML = `
      <span class="tag-dot" style="background:${tag.color || "#888"}"></span>
      <button class="tag-apply-btn">${tag.tag}</button>
    `;
    item.querySelector(".tag-apply-btn").addEventListener("click", async () => {
      $("tagDialog").close();
      await dispatchAction("tag", { tagKey: tag.key });
    });
    list.appendChild(item);
  }
  $("tagDialog").showModal();
  $("tagCancel").onclick = () => $("tagDialog").close();
}

// ─── Unsubscribe ──────────────────────────────────────────────────────────────
async function handleUnsubscribe(entry = state.allSenders.find(e => e.email === [...state.selected][0])) {

  if (!entry?.messageIds?.length) {
    if (state.selectedMessages.size > 0) {
      alert(_("unsubscribeWholeSendersOnly"));
    }
    return;
  }

  let info = entry.unsubscribeInfo;

  if (!info || info.kind === "none") {
    const messageId = entry.newestMessageId || entry.messageIds[0];

    info = await browser.runtime.sendMessage({
      action: "getUnsubscribeInfo",
      messageId,
    });

    entry.unsubscribeChecked = true;
    entry.hasUnsubscribe = Boolean(info?.kind && info.kind !== "none");
    entry.unsubscribeInfo = info || { kind: "none" };
    entry.unsubscribeKind = info?.kind || "none";
    invalidateDomainGroupsCache();

    const accountId = $("accountSelect").value;
    const folderId = $("folderSelect").value;
    await saveScanCache(accountId, folderId, state.allSenders);

    applyFilter();
    updateCleanupAssistant();
    updateCleanupDashboard();
  }

  if (!info || info.kind === "none") {
    alert(_("unsubscribe_noLink"));
    return;
  }

  if (info.kind === "mailto") {
    await browser.runtime.sendMessage({
      action: "doCompose",
      to: info.address,
      subject: info.subject || "Unsubscribe",
    });
    return;
  }

  if (info.kind === "https") {
    if (confirm(`Diese URL wird in deinem Browser geöffnet:\n\n${info.url}\n\nFortfahren?`)) {
      browser.windows.openDefaultBrowser(info.url);
    }
  }
}

// ─── Undo toast ───────────────────────────────────────────────────────────────
// ponytail: simple toast for non-undo notifications
function showToast(message) {
  const toast = $("undoToast"), countdown = $("undoCountdown");
  toast.hidden = false;
  countdown.textContent = message;
  setTimeout(() => { toast.hidden = true; }, 3000);
}

function showUndoToast(message = "") {
  if (state.undoTimer) clearInterval(state.undoTimer);
  let seconds = 10;
  const toast = $("undoToast"), countdown = $("undoCountdown");
  toast.hidden = false;
  const render = () => {
    countdown.textContent = `${message ? message + " · " : ""}(${seconds}s)`;
  };
  render();
  state.undoTimer = setInterval(() => {
    seconds--;
    if (seconds <= 0) { clearInterval(state.undoTimer); toast.hidden = true; return; }
    render();
  }, 1000);
}

async function handleUndo() {
  if (state.undoTimer) { clearInterval(state.undoTimer); $("undoToast").hidden = true; }

  await appendActionLog({
    type: "undo",
    accountId: $("accountSelect").value,
    accountName: currentAccountName(),
    folderId: $("folderSelect").value,
    folderName: currentFolderName(),
    senderCount: 0,
    inputMessageCount: 0,
    affectedMessageCount: 0,
    skippedCount: 0,
    sizeBytes: 0,
    options: {},
    undoable: false,
    senders: [],
  });

  const response = await browser.runtime.sendMessage({ action: "undo" });
  if (response?.error) { alert(response.error); return; }
  if (response?.failedCount > 0) {
    alert(_("undo_partial_failure", [response.failedCount]));
  }
  await startScan();
}

// ─── Protect toggle ───────────────────────────────────────────────────────────
async function toggleProtect(email) {
  const isProtected = state.protectedEmails.has(email);
  const response = await browser.runtime.sendMessage({
    action: "toggleProtect", email, protect: !isProtected, kind: "sender",
  });
  if (response?.error) { alert(response.error); return; }

  state.protectedEmails = new Set(response.protectedEmails);
  if (state.protectedEmails.has(email)) state.selected.delete(email);

  const entry  = state.filteredSenders.find(e => e.email === email);
  const oldRow = findRow(email);
  if (entry && oldRow) {
    const wasActive = oldRow.tabIndex === 0;
    const newRow = createSenderRow(entry);
    oldRow.replaceWith(newRow);
    if (wasActive) newRow.tabIndex = 0;
  }
  updateSelectionLabel();
  updateActionButtons();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function protectedEmailEntries() {
  const q = normalizeEmail($("protectManagerFilter")?.value || "");

  return [...state.protectedEmails]
    .map(normalizeEmail)
    .filter(Boolean)
    .filter(email => !q || email.includes(q))
    .sort((a, b) => a.localeCompare(b));
}

function renderProtectManagerEntry(email) {
  const sender = state.allSenders.find(s => normalizeEmail(s.email) === email);

  const details = sender
    ? `${sender.count} Mails · ${formatSize(sender.totalSizeBytes)} · letzte Mail ${formatRelativeDate(sender.newestDate)}`
    : _("protectNotInCurrentAnalysis");

  return `
    <div class="protect-manager-entry">
      <div class="protect-manager-entry-main">
        <div class="protect-manager-email">${escapeHtml(email)}</div>
        <div class="protect-manager-details">${escapeHtml(details)}</div>
      </div>
      <button class="protect-manager-remove danger" data-email="${escapeHtml(email)}">
        ${_("protectManagerUnlock")}
      </button>
    </div>
  `;
}

function renderProtectManager() {
  const list = $("protectManagerList");
  if (!list) return;

  const emails = protectedEmailEntries();

  if (emails.length === 0) {
    list.innerHTML = `
      <div class="protect-manager-empty">
${_("protectManagerEmpty")}
      </div>
    `;
    return;
  }

  list.innerHTML = emails.map(renderProtectManagerEntry).join("");

  list.querySelectorAll(".protect-manager-remove").forEach(button => {
    button.addEventListener("click", async () => {
      await removeProtectedEmail(button.dataset.email);
    });
  });
}

async function openProtectManagerDialog() {
  if ($("protectManagerFilter")) {
    $("protectManagerFilter").value = "";
  }

  renderProtectManager();
  $("protectManagerDialog").showModal();
}

async function setProtectedEmailsFromList(emails) {
  const normalizedEmails = [...new Set(
    (emails || [])
      .map(normalizeEmail)
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));

  const response = await browser.runtime.sendMessage({
    action: "setProtectedEmails",
    emails: normalizedEmails,
  });

  if (response?.error) {
    showError(response.error);
    return false;
  }

  state.protectedEmails = new Set(response.protectedEmails || normalizedEmails);

  state.selected.clear();
  applyFilter();
  updateSelectionLabel();
  updateActionButtons();
  updateCleanupAssistant();
  updateCleanupDashboard();
  scheduleFeatureStatusUpdate();
  renderProtectManager();

  return true;
}

async function removeProtectedEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return;

  const emails = [...state.protectedEmails]
    .map(normalizeEmail)
    .filter(existing => existing && existing !== normalizedEmail);

  await setProtectedEmailsFromList(emails);
}

async function clearProtectedEmailsWithConfirm() {
  const count = state.protectedEmails.size;

  if (count === 0) {
    renderProtectManager();
    return;
  }

  if (!confirm(_("protectManagerClearConfirm", [count]))) {
    return;
  }

  await setProtectedEmailsFromList([]);
}

function exportProtectedEmails() {
  const emails = [...state.protectedEmails]
    .map(normalizeEmail)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  const payload = {
    exportedAt: new Date().toISOString(),
    app: "MailManager",
    type: "protectedEmails",
    version: 1,
    emails,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json;charset=utf-8",
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");

  a.href = url;
  a.download = `mailmanager-protected-emails-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();

  URL.revokeObjectURL(url);
}

function normalizeImportedProtectedEmailsPayload(payload) {
  if (Array.isArray(payload)) {
    return payload.map(normalizeEmail).filter(Boolean);
  }

  if (payload?.type === "protectedEmails" && Array.isArray(payload.emails)) {
    return payload.emails.map(normalizeEmail).filter(Boolean);
  }

  if (payload?.protectedEmails && Array.isArray(payload.protectedEmails)) {
    return payload.protectedEmails.map(normalizeEmail).filter(Boolean);
  }

  return [];
}

async function importProtectedEmailsFromFile(event) {
  const input = event.target;
  const file = input?.files?.[0];

  if (!file) return;

  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    const importedEmails = normalizeImportedProtectedEmailsPayload(payload);

    if (importedEmails.length === 0) {
      alert("Keine gültigen geschützten Absender in dieser Datei gefunden.");
      return;
    }

    const mergedEmails = [...new Set([
      ...[...state.protectedEmails].map(normalizeEmail),
      ...importedEmails,
    ])].sort((a, b) => a.localeCompare(b));

    const duplicateCount =
      importedEmails.length - importedEmails.filter(email => !state.protectedEmails.has(email)).length;

    const ok = confirm(
      `${importedEmails.length} geschützte Absender importieren?\n\n` +
      `${duplicateCount} davon sind bereits vorhanden.\n` +
      `Die bestehende Schutzliste bleibt erhalten und wird ergänzt.`
    );

    if (!ok) return;

    await setProtectedEmailsFromList(mergedEmails);

    if (typeof appendActionLog === "function") {
      await appendActionLog({
        type: "protected-import",
        accountId: $("accountSelect").value,
        accountName: currentAccountName(),
        folderId: $("folderSelect").value,
        folderName: currentFolderName(),
        senderCount: importedEmails.length,
        inputMessageCount: 0,
        affectedMessageCount: importedEmails.length,
        skippedCount: duplicateCount,
        sizeBytes: 0,
        options: {},
        undoable: false,
        senders: [],
      });
    }

    $("statsLabel").textContent =
      `${importedEmails.length} geschützte Absender importiert.`;
  } catch (err) {
    alert(_("cleanup_import_failed", [err.message]));
  } finally {
    if (input) input.value = "";
  }
}

function currentViewMode() {
  return state.viewMode || "senders";
}

function currentAccountId() {
  return $("accountSelect")?.value || "";
}

function currentFolderId() {
  return $("folderSelect")?.value || "";
}

function currentFilterText() {
  return $("filterInput")?.value || "";
}

async function countLocalStorageObject(key, loader) {
  try {
    if (typeof loader !== "function") return null;
    const value = await loader();

    if (Array.isArray(value)) return value.length;
    if (value && typeof value === "object") return Object.keys(value).length;

    return 0;
  } catch {
    return null;
  }
}

async function buildFrontendDiagnostics() {
  const accountId = currentAccountId();
  const folderId = currentFolderId();

  const account = state.accounts.find(a => a.id === accountId);
  const folder = account?.folders?.find(f => f.id === folderId);

  let cacheInfo = null;
  try {
    if (typeof loadScanCache === "function") {
      const cached = await loadScanCache(accountId, folderId);
      cacheInfo = cached
        ? {
            exists: true,
            savedAt: cached.savedAt,
            senderCount: cached.senders?.length || 0,
          }
        : { exists: false };
    }
  } catch (err) {
    cacheInfo = {
      exists: false,
      error: err.message,
    };
  }

  const cleanupRuleCount = await countLocalStorageObject(
    "cleanupRules",
    typeof loadCleanupRules === "function" ? loadCleanupRules : null
  );

  const actionLogCount = await countLocalStorageObject(
    "actionLog",
    typeof loadActionLog === "function" ? loadActionLog : null
  );

  return {
    ui: {
      viewMode: currentViewMode(),
      quickFilter: state.quickFilter || "all",
      sortKey: state.sortKey,
      sortDesc: state.sortDesc,
      filterText: currentFilterText(),
      activeScan: Boolean(state.activeScanId),
      scanCancelRequested: Boolean(state.scanCancelRequested),
    },
    selection: {
      selectedSenderCount: state.selected?.size || 0,
      selectedEmails: [...(state.selected || [])].slice(0, 20),
      selectedEmailsTruncated: (state.selected?.size || 0) > 20,
    },
    currentData: {
      allSenderCount: state.allSenders?.length || 0,
      filteredSenderCount: state.filteredSenders?.length || 0,
      filteredDomainCount: state.filteredDomains?.length || 0,
      expandedDomainCount: state.expandedDomains?.size || 0,
      protectedEmailCount: state.protectedEmails?.size || 0,
      protectedFolderCount: state.protectedFolderIds?.size || 0,
    },
    currentLocation: {
      accountId,
      accountName: account?.name || "",
      folderId,
      folderName: folder?.name || "",
    },
    localState: {
      scanCache: cacheInfo,
      cleanupRuleCount,
      actionLogCount,
    },
  };
}

async function buildDiagnosticsPayload() {
  const accountId = currentAccountId();

  const [frontend, background] = await Promise.all([
    buildFrontendDiagnostics(),
    browser.runtime.sendMessage({
      action: "diagnostics",
      accountId,
    }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    frontend,
    background,
  };
}

async function refreshDiagnosticsDialog() {
  const output = $("diagnosticsOutput");
  if (!output) return;

  output.textContent = _("diagnosticsLoading");

  try {
    const payload = await buildDiagnosticsPayload();
    output.textContent = JSON.stringify(payload, null, 2);
  } catch (err) {
    output.textContent = JSON.stringify({
      error: err.message,
      generatedAt: new Date().toISOString(),
    }, null, 2);
  }
}

async function openDiagnosticsDialog() {
  $("diagnosticsDialog").showModal();
  await refreshDiagnosticsDialog();
}

async function copyDiagnosticsToClipboard() {
  const output = $("diagnosticsOutput");
  if (!output) return;

  const text = output.textContent || "";

  try {
    await navigator.clipboard.writeText(text);
    $("statsLabel").textContent = _("diagnosticsCopied");
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";

    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    try {
      document.execCommand("copy");
      $("statsLabel").textContent = _("diagnosticsCopied");
    } finally {
      textarea.remove();
    }
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────
function handleExport(format) {
  $("exportDialog").close();
  const senders = state.filteredSenders;
  if (senders.length === 0) { alert(_("export_no_data")); return; }

  const date     = new Date().toISOString().slice(0, 10);
  const content  = format === "csv" ? toCSV(senders) : toJSON(senders);
  const filename = `mailmanager-export-${date}.${format}`;
  const mimeType = format === "csv" ? "text/csv" : "application/json";

  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Custom Regex Rules ────────────────────────────────────────────────────────

async function loadCustomRegexRules() {
  try {
    const data = await browser.storage.local.get(CUSTOM_REGEX_RULES_KEY);
    return Array.isArray(data?.[CUSTOM_REGEX_RULES_KEY])
      ? data[CUSTOM_REGEX_RULES_KEY]
      : [];
  } catch (_) { return []; }
}

async function saveCustomRegexRules(rules) {
  await browser.storage.local.set({ [CUSTOM_REGEX_RULES_KEY]: rules || [] });
}

function addCustomRegexRule(pattern, title) {
  if (!pattern) return;
  state.customRegexRules.push({
    pattern,
    title: title || pattern,
    enabled: true,
  });
  saveCustomRegexRules(state.customRegexRules);
  renderCustomRegexList();
}

async function deleteCustomRegexRule(index) {
  state.customRegexRules.splice(index, 1);
  await saveCustomRegexRules(state.customRegexRules);
  renderCustomRegexList();
}

async function toggleCustomRegexRule(index) {
  state.customRegexRules[index].enabled = !state.customRegexRules[index].enabled;
  await saveCustomRegexRules(state.customRegexRules);
  renderCustomRegexList();
}

function formatCustomRegexList() {
  if (state.customRegexRules.length === 0) {
    return `<div class="custom-regex-empty">${_("customRegexEmpty")}</div>`;
  }
  return state.customRegexRules.map((r, i) => `
    <div class="custom-regex-entry ${r.enabled ? "" : "disabled"}">
      <span class="custom-regex-toggle" data-regex-idx="${i}">${r.enabled ? "🟢" : "⚪"}</span>
      <span class="custom-regex-title">${escapeHtml(r.title)}</span>
      <code class="custom-regex-pattern">${escapeHtml(r.pattern)}</code>
      <button class="custom-regex-delete" data-regex-idx="${i}" title="${_("cleanupRuleDelete")}">✕</button>
    </div>
  `).join("");
}

function renderCustomRegexList() {
  const list = $("#customRegexList");
  if (!list) return;
  list.innerHTML = formatCustomRegexList();

  list.querySelectorAll(".custom-regex-delete").forEach(btn => {
    btn.addEventListener("click", () => deleteCustomRegexRule(Number(btn.dataset.regexIdx)));
  });
  list.querySelectorAll(".custom-regex-toggle").forEach(el => {
    el.addEventListener("click", () => toggleCustomRegexRule(Number(el.dataset.regexIdx)));
  });
}

// ─── Quick actions ─────────────────────────────────────────────────────────────

async function quickEmptyFolder() {
  const accountId = $("accountSelect").value;
  if (!accountId) { showError(_("errorNoAccountSelected")); return; }

  if (!confirm(_("quickEmptyConfirmSpam"))) return;

  try {
    const btn = $("quickEmptySpamBtn");
    if (btn) { btn.disabled = true; btn.textContent = _("quickEmptyCalculating"); }

    const resp = await browser.runtime.sendMessage({
      action: "quickEmpty",
      accountId,
      folderType: "junk",
    });

    if (resp?.error) { showError(resp.error); return; }
    if (resp.count) {
      await appendActionLog({
        type: "trash",
        accountId,
        accountName: currentAccountName(),
        folderId: resp.folderId,
        folderName: resp.folderName,
        senderCount: 0,
        inputMessageCount: resp.totalInputCount || resp.count,
        affectedMessageCount: resp.movedCount || resp.count,
        skippedCount: resp.skippedCount || 0,
        sizeBytes: 0,
        options: {},
        undoable: Boolean(resp.undoable),
        senders: [],
      });
      if (resp.undoable) {
        const msg = `${_("quickEmptySuccessSpam")} (${resp.count || 0} ${_("colCount").toLowerCase()})`;
        showUndoToast(msg);
        if (resp.failedCount > 0) {
          alert(_("quickempty_partial_failure", [resp.failedCount]));
        }
      } else {
        showToast(_("quickEmptySuccessSpam") + ` (${resp.count || 0} ${_("colCount").toLowerCase()})`);
        if (resp.failedCount > 0) {
          showToast(_("quickempty_partial_failure", [resp.failedCount]));
        }
      }
      await startScan();
    } else {
      showToast(_("quickEmptyAlreadyEmptySpam"));
    }
  } catch (err) {
    showError(_("quickEmptyFailed", [err.message]));
  } finally {
    const btn = $("quickEmptySpamBtn");
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#icon-unsubscribe"/></svg> ${_("quickEmptySpam")}`;
    }
  }
}

// ponytail: check sender against all enabled custom regex rules
// returns first matching rule title, or null
function matchCustomRegexRules(sender) {
  const text = [sender.email, sender.displayName].filter(Boolean).join(" ").toLowerCase();
  for (const rule of state.customRegexRules) {
    if (!rule.enabled) continue;
    try {
      if (new RegExp(rule.pattern, "i").test(text)) return rule.title;
    } catch (_) { /* invalid regex — skip */ }
  }
  return null;
}

function localizeDocument() {
  const _get = (key) => browser.i18n.getMessage(key) || "";

  function resolveMessages(value) {
    return value.replace(
      /__MSG_([A-Za-z0-9_@]+)__/g,
      (match, key) => _get(key) || match
    );
  }

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT
  );

  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.nodeValue?.includes("__MSG_")) {
      node.nodeValue = resolveMessages(node.nodeValue);
    }
  }

  for (const element of document.body.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      if (!attribute.value.includes("__MSG_")) continue;
      element.setAttribute(attribute.name, resolveMessages(attribute.value));
    }
  }

  document.documentElement.lang = browser.i18n.getUILanguage() || "de";
}

document.addEventListener("DOMContentLoaded", () => {
  localizeDocument();
  init();
});
