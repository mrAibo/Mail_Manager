import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPreviewText } from "../shared/message-preview.mjs";

test("extracts plain-text body", () => {
  const msg = { contentType: "text/plain", body: "Hallo Welt\nZeile zwei" };
  assert.equal(extractPreviewText(msg), "Hallo Welt\nZeile zwei");
});

test("finds text/plain inside nested parts", () => {
  const msg = {
    contentType: "multipart/alternative",
    parts: [
      { contentType: "text/html", body: "<p>ignoriert</p>" },
      { contentType: "text/plain", body: "echter Text" },
    ],
  };
  assert.equal(extractPreviewText(msg), "echter Text");
});

test("falls back to stripped HTML when no plain part", () => {
  const msg = {
    contentType: "multipart/mixed",
    parts: [{ contentType: "text/html", body: "<h1>Titel</h1><p>Absatz &amp; mehr</p>" }],
  };
  assert.equal(extractPreviewText(msg), "Titel Absatz & mehr");
});

test("drops style/script blocks from HTML", () => {
  const msg = {
    contentType: "text/html",
    body: "<style>.a{color:red}</style><p>sichtbar</p><script>alert(1)</script>",
  };
  assert.equal(extractPreviewText(msg), "sichtbar");
});

test("limits to maxLines", () => {
  const body = ["a", "b", "c", "d", "e"].join("\n");
  const msg = { contentType: "text/plain", body };
  assert.equal(extractPreviewText(msg, { maxLines: 2 }), "a\nb");
});

test("limits to maxChars with ellipsis", () => {
  const msg = { contentType: "text/plain", body: "abcdefghij" };
  assert.equal(extractPreviewText(msg, { maxChars: 5 }), "abcde…");
});

test("drops empty lines and collapses whitespace", () => {
  const msg = { contentType: "text/plain", body: "  Zeile   eins  \n\n\n   \nZeile zwei" };
  assert.equal(extractPreviewText(msg, { maxLines: 10 }), "Zeile eins\nZeile zwei");
});

test("returns empty string when no usable body", () => {
  const msg = { contentType: "multipart/mixed", parts: [{ contentType: "image/png" }] };
  assert.equal(extractPreviewText(msg), "");
});
