import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseAuthor,
  computeRiskScore, formatSize, formatRelativeDate,
  toCSV, toJSON,
} from "../shared/utils.js";

describe("parseAuthor", () => {
  it("parses 'Name <email>'", () => {
    assert.deepEqual(parseAuthor("Big Shop <newsletter@bigshop.de>"),
      { email: "newsletter@bigshop.de", displayName: "Big Shop" });
  });
  it("handles bare email address", () => {
    assert.deepEqual(parseAuthor("newsletter@bigshop.de"),
      { email: "newsletter@bigshop.de", displayName: "" });
  });
  it("lowercases the email address", () => {
    assert.deepEqual(parseAuthor("Shop <NEWSLETTER@BIGSHOP.DE>"),
      { email: "newsletter@bigshop.de", displayName: "Shop" });
  });
  it("strips quotes from display name", () => {
    assert.deepEqual(parseAuthor('"Big Shop" <newsletter@bigshop.de>'),
      { email: "newsletter@bigshop.de", displayName: "Big Shop" });
  });
  it("returns empty strings for empty input", () => {
    assert.deepEqual(parseAuthor(""), { email: "", displayName: "" });
  });
});

describe("computeRiskScore", () => {
  it("returns high score for never-read high-volume old sender", () => {
    const score = computeRiskScore({
      count: 200, readCount: 0,
      oldestDate: new Date("2020-01-01"), newestDate: new Date("2020-06-01"),
    }, new Date("2026-05-10"));
    assert.ok(score >= 85, `Expected >= 85, got ${score}`);
  });
  it("returns low score for frequently-read recent sender", () => {
    const score = computeRiskScore({
      count: 5, readCount: 5,
      oldestDate: new Date("2026-04-01"), newestDate: new Date("2026-05-09"),
    }, new Date("2026-05-10"));
    assert.ok(score <= 20, `Expected <= 20, got ${score}`);
  });
  it("clamps result to 0–100", () => {
    const score = computeRiskScore(
      { count: 0, readCount: 0, oldestDate: new Date(), newestDate: new Date() },
      new Date());
    assert.ok(score >= 0 && score <= 100);
  });
});

describe("formatSize", () => {
  it("formats bytes", () => assert.equal(formatSize(512), "512 B"));
  it("formats KB",    () => assert.equal(formatSize(1536), "1.5 KB"));
  it("formats MB",    () => assert.equal(formatSize(2097152), "2.0 MB"));
});

describe("formatRelativeDate", () => {
  const now = new Date("2026-05-10");
  it("returns 'heute'",       () => assert.equal(formatRelativeDate(new Date("2026-05-10"), now), "heute"));
  it("returns 'vor 2 Tagen'", () => assert.equal(formatRelativeDate(new Date("2026-05-08"), now), "vor 2 Tagen"));
  it("returns months",        () => assert.equal(formatRelativeDate(new Date("2026-02-10"), now), "vor 3 Monaten"));
  it("returns full date for old", () => assert.equal(formatRelativeDate(new Date("2024-01-15"), now), "15.01.2024"));
});

const sample = [{
  email: "news@shop.de", displayName: "Shop",
  count: 10, totalSizeBytes: 1048576, readCount: 2,
  oldestDate: new Date("2025-01-01"), newestDate: new Date("2026-05-01"),
  riskScore: 75, sampleSubjects: ["Sale!", "Neu"],
}];

describe("toCSV", () => {
  it("produces header and one data row", () => {
    const lines = toCSV(sample).trim().split("\n");
    assert.equal(lines[0], "email,displayName,count,totalSizeMB,readPercent,oldestDate,newestDate,riskScore");
    assert.ok(lines[1].startsWith("news@shop.de,Shop,10,1.0,20,2025-01-01,2026-05-01,75"));
  });
  it("quotes displayName containing a comma", () => {
    assert.ok(toCSV([{ ...sample[0], displayName: "Shop, GmbH" }]).includes('"Shop, GmbH"'));
  });
  it("escapes quotes inside CSV fields", () => {
    assert.ok(toCSV([{ ...sample[0], displayName: 'Alice "Admin", GmbH' }])
      .includes('"Alice ""Admin"", GmbH"'));
  });
  it("neutralizes spreadsheet formulas in untrusted fields", () => {
    const row = toCSV([{ ...sample[0], displayName: "=1+1" }]).trim().split("\n")[1];
    assert.equal(row.split(",")[1], "'=1+1");
  });
  it("neutralizes formulas after leading whitespace", () => {
    const row = toCSV([{ ...sample[0], displayName: " \t=1+1" }]).trim().split("\n")[1];
    assert.equal(row.split(",")[1], "' \t=1+1");
  });
});

describe("toJSON", () => {
  it("produces valid JSON with correct fields", () => {
    const parsed = JSON.parse(toJSON(sample));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].email, "news@shop.de");
    assert.equal(parsed[0].readPercent, 20);
    assert.equal(parsed[0].totalSizeMB, 1.0);
  });
});
