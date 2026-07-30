import test from "node:test";
import assert from "node:assert/strict";

import {
  computeCleanupScore,
  computeBulkScore,
  emailHost,
  normalizeDomain,
  isInactiveForDays,
  senderReadRate,
  looksLikePersonalSender,
  isProtectionCandidate,
  suggestCleanupRuleForSenders,
} from "../shared/cleanup-logic.mjs";

test("computeCleanupScore returns 0 for empty sender", () => {
  assert.equal(computeCleanupScore({
    count: 0,
    readCount: 0,
    oldestDate: new Date("2025-01-01"),
    newestDate: new Date("2025-01-01"),
  }), 0);
});

test("computeCleanupScore increases for unread and inactive sender", () => {
  const score = computeCleanupScore({
    count: 100,
    readCount: 0,
    oldestDate: new Date("2024-01-01"),
    newestDate: new Date("2024-01-01"),
  }, new Date("2026-01-01"));

  assert.ok(score >= 60, `expected high score, got ${score}`);
});

test("computeCleanupScore remains lower for recent mostly read sender", () => {
  const score = computeCleanupScore({
    count: 10,
    readCount: 10,
    oldestDate: new Date("2026-01-01"),
    newestDate: new Date("2026-01-10"),
  }, new Date("2026-01-15"));

  assert.ok(score < 40, `expected low-ish score, got ${score}`);
});

test("computeBulkScore detects newsletter by email", () => {
  const result = computeBulkScore("newsletter@example.com", "", []);

  assert.equal(result.isBulkCandidate, true);
  assert.ok(result.bulkScore >= 20);
});

test("computeBulkScore detects marketing by subject", () => {
  const result = computeBulkScore("info@example.com", "Example", [
    "Rabatt Aktion nur heute",
  ]);

  assert.equal(result.isBulkCandidate, true);
  assert.ok(result.bulkReasons.length >= 1);
});

test("computeBulkScore does not mark ordinary personal address as bulk", () => {
  const result = computeBulkScore("max.mustermann@example.com", "Max Mustermann", [
    "Termin morgen",
  ]);

  assert.equal(result.isBulkCandidate, false);
});

test("emailHost extracts host from address", () => {
  assert.equal(emailHost("User <news@mail.amazon.de>"), "mail.amazon.de");
  assert.equal(emailHost("newsletter@example.com"), "example.com");
});

test("normalizeDomain collapses common subdomains", () => {
  assert.equal(normalizeDomain("mail.amazon.de"), "amazon.de");
  assert.equal(normalizeDomain("news.amazon.de"), "amazon.de");
  assert.equal(normalizeDomain("tracking.amazon.de"), "amazon.de");
});

test("normalizeDomain preserves common second-level country domains", () => {
  assert.equal(normalizeDomain("mail.amazon.co.uk"), "amazon.co.uk");
  assert.equal(normalizeDomain("news.example.com.au"), "example.com.au");
});

test("normalizeDomain handles normal domains and empty values", () => {
  assert.equal(normalizeDomain("example.com"), "example.com");
  assert.equal(normalizeDomain(""), "unbekannt");
});

test("isInactiveForDays detects inactive date", () => {
  assert.equal(
    isInactiveForDays("2024-01-01", 365, new Date("2026-01-01")),
    true
  );
});

test("isInactiveForDays detects recent date", () => {
  assert.equal(
    isInactiveForDays("2025-12-15", 365, new Date("2026-01-01")),
    false
  );
});

test("senderReadRate computes read ratio", () => {
  assert.equal(senderReadRate({ count: 10, readCount: 7 }), 0.7);
  assert.equal(senderReadRate({ count: 0, readCount: 0 }), 0);
});

test("looksLikePersonalSender rejects bulk candidates", () => {
  assert.equal(
    looksLikePersonalSender({
      email: "newsletter@example.com",
      displayName: "Newsletter",
      isBulkCandidate: true,
    }),
    false
  );
});

test("looksLikePersonalSender accepts ordinary sender", () => {
  assert.equal(
    looksLikePersonalSender({
      email: "anna@example.com",
      displayName: "Anna Beispiel",
      isBulkCandidate: false,
      hasUnsubscribe: false,
    }),
    true
  );
});

test("isProtectionCandidate detects recent personal sender", () => {
  assert.equal(
    isProtectionCandidate({
      email: "anna@example.com",
      displayName: "Anna Beispiel",
      count: 2,
      readCount: 2,
      newestDate: new Date("2026-01-10"),
      isBulkCandidate: false,
      hasUnsubscribe: false,
    }, new Date("2026-01-15")),
    true
  );
});

test("isProtectionCandidate rejects newsletter", () => {
  assert.equal(
    isProtectionCandidate({
      email: "newsletter@example.com",
      displayName: "Newsletter",
      count: 200,
      readCount: 0,
      newestDate: new Date("2026-01-10"),
      isBulkCandidate: true,
      hasUnsubscribe: false,
    }, new Date("2026-01-15")),
    false
  );
});

test("suggestCleanupRuleForSenders suggests newsletter rule", () => {
  const rule = suggestCleanupRuleForSenders([
    { email: "n1@example.com", count: 20, totalSizeBytes: 1000, isBulkCandidate: true },
    { email: "n2@example.com", count: 30, totalSizeBytes: 1000, isBulkCandidate: true },
    { email: "n3@example.com", count: 40, totalSizeBytes: 1000, isBulkCandidate: true },
  ], new Date("2026-01-01"));

  assert.equal(rule.olderThanDays, 90);
  assert.equal(rule.keepNewest, 3);
});

test("suggestCleanupRuleForSenders suggests inactive rule", () => {
  const rule = suggestCleanupRuleForSenders([
    {
      email: "old1@example.com",
      count: 10,
      totalSizeBytes: 1000,
      newestDate: new Date("2023-01-01"),
      isBulkCandidate: false,
    },
    {
      email: "old2@example.com",
      count: 20,
      totalSizeBytes: 1000,
      newestDate: new Date("2023-02-01"),
      isBulkCandidate: false,
    },
  ], new Date("2026-01-01"));

  assert.equal(rule.olderThanDays, 365);
  assert.equal(rule.keepNewest, 1);
});

test("suggestCleanupRuleForSenders suggests storage rule", () => {
  const rule = suggestCleanupRuleForSenders([
    {
      email: "big@example.com",
      count: 50,
      totalSizeBytes: 600 * 1024 * 1024,
      newestDate: new Date("2025-12-01"),
      isBulkCandidate: false,
    },
  ], new Date("2026-01-01"));

  assert.equal(rule.olderThanDays, 365);
  assert.equal(rule.keepNewest, 5);
});

test("suggestCleanupRuleForSenders returns null for empty list", () => {
  assert.equal(suggestCleanupRuleForSenders([], new Date("2026-01-01")), null);
});
