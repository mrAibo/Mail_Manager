import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchesAdvancedFilter, isTextEntryTarget } from "../tab/tab-utilities.js";

// Minimaler DOM-Element-Stub für isTextEntryTarget.
const el = (tagName, { type, isContentEditable = false } = {}) => ({
  tagName,
  isContentEditable,
  getAttribute: name => (name === "type" ? type ?? null : null),
});

describe("isTextEntryTarget", () => {
  it("returns false for null", () => {
    assert.equal(isTextEntryTarget(null), false);
  });

  it("treats a checkbox as NOT a text entry target", () => {
    assert.equal(isTextEntryTarget(el("INPUT", { type: "checkbox" })), false);
  });

  it("treats radio and button inputs as NOT text entry targets", () => {
    assert.equal(isTextEntryTarget(el("INPUT", { type: "radio" })), false);
    assert.equal(isTextEntryTarget(el("INPUT", { type: "button" })), false);
  });

  it("treats text, search and number inputs as text entry targets", () => {
    assert.equal(isTextEntryTarget(el("INPUT", { type: "text" })), true);
    assert.equal(isTextEntryTarget(el("INPUT", { type: "search" })), true);
    assert.equal(isTextEntryTarget(el("INPUT", { type: "number" })), true);
  });

  it("treats an input without an explicit type as a text entry target", () => {
    assert.equal(isTextEntryTarget(el("INPUT")), true);
  });

  it("treats textarea and select as text entry targets", () => {
    assert.equal(isTextEntryTarget(el("TEXTAREA")), true);
    assert.equal(isTextEntryTarget(el("SELECT")), true);
  });

  it("treats a contentEditable element as a text entry target", () => {
    assert.equal(isTextEntryTarget(el("DIV", { isContentEditable: true })), true);
  });

  it("treats an ordinary div as NOT a text entry target", () => {
    assert.equal(isTextEntryTarget(el("DIV")), false);
  });
});

const DAY = 86400000;
const daysAgo = n => new Date(Date.now() - n * DAY);

// Basis-Absender: 100 MB, letzte Mail vor 200 Tagen, 10 Mails / 4 gelesen.
const baseSender = {
  email: "news@shop.de",
  count: 10,
  readCount: 4,
  totalSizeBytes: 100 * 1024 * 1024,
  newestDate: daysAgo(200),
};

describe("matchesAdvancedFilter", () => {
  it("returns true when filter is empty or null", () => {
    assert.equal(matchesAdvancedFilter(baseSender, null), true);
    assert.equal(matchesAdvancedFilter(baseSender, {}), true);
  });

  it("filters by minimum size", () => {
    assert.equal(matchesAdvancedFilter(baseSender, { sizeMinMB: 50 }), true);
    assert.equal(matchesAdvancedFilter(baseSender, { sizeMinMB: 150 }), false);
  });

  it("filters by maximum size", () => {
    assert.equal(matchesAdvancedFilter(baseSender, { sizeMaxMB: 150 }), true);
    assert.equal(matchesAdvancedFilter(baseSender, { sizeMaxMB: 50 }), false);
  });

  it("filters by size range (both bounds)", () => {
    assert.equal(matchesAdvancedFilter(baseSender, { sizeMinMB: 50, sizeMaxMB: 150 }), true);
    assert.equal(matchesAdvancedFilter(baseSender, { sizeMinMB: 110, sizeMaxMB: 150 }), false);
  });

  it("filters by minimum age since last mail (inactive senders)", () => {
    assert.equal(matchesAdvancedFilter(baseSender, { lastMailDaysMin: 100 }), true);
    assert.equal(matchesAdvancedFilter(baseSender, { lastMailDaysMin: 300 }), false);
  });

  it("filters by maximum age since last mail (recently active senders)", () => {
    assert.equal(matchesAdvancedFilter(baseSender, { lastMailDaysMax: 300 }), true);
    assert.equal(matchesAdvancedFilter(baseSender, { lastMailDaysMax: 100 }), false);
  });

  it("excludes senders with unknown date when a date filter is active", () => {
    const noDate = { ...baseSender, newestDate: null };
    assert.equal(matchesAdvancedFilter(noDate, { lastMailDaysMin: 30 }), false);
    assert.equal(matchesAdvancedFilter(noDate, {}), true);
  });

  it("filters by read status 'read' (all mails read)", () => {
    const allRead = { ...baseSender, count: 10, readCount: 10 };
    assert.equal(matchesAdvancedFilter(allRead, { readStatus: "read" }), true);
    assert.equal(matchesAdvancedFilter(baseSender, { readStatus: "read" }), false);
  });

  it("filters by read status 'unread' (has unread mails)", () => {
    const allRead = { ...baseSender, count: 10, readCount: 10 };
    assert.equal(matchesAdvancedFilter(baseSender, { readStatus: "unread" }), true);
    assert.equal(matchesAdvancedFilter(allRead, { readStatus: "unread" }), false);
  });

  it("treats read status 'all' as no constraint", () => {
    assert.equal(matchesAdvancedFilter(baseSender, { readStatus: "all" }), true);
  });

  it("combines multiple criteria with AND logic", () => {
    const filter = { sizeMinMB: 50, lastMailDaysMin: 100, readStatus: "unread" };
    assert.equal(matchesAdvancedFilter(baseSender, filter), true);

    // Same filter, but sender is fully read -> fails the readStatus criterion.
    const allRead = { ...baseSender, readCount: 10 };
    assert.equal(matchesAdvancedFilter(allRead, filter), false);
  });
});
