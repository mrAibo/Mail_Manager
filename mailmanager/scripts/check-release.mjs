import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const fail = message => { console.error(`ERROR: ${message}`); process.exitCode = 1; };
let manifest;

try {
  manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
} catch (error) {
  fail(`manifest.json is not valid JSON: ${error.message}`);
}

let pkg;
try {
  pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
} catch (error) {
  fail(`package.json is not valid JSON: ${error.message}`);
}

if (manifest && !/^\d+(?:\.\d+){0,3}$/.test(manifest.version || "")) {
  fail(`manifest version must be 1-4 numeric components: ${manifest.version || "(missing)"}`);
}
if (manifest && pkg && manifest.version !== pkg.version) {
  fail(`manifest.version (${manifest.version}) does not match package.version (${pkg.version})`);
}
if (!manifest?.browser_specific_settings?.gecko?.id?.trim()) {
  fail("permanent Gecko extension ID is missing");
}
if (manifest?.permissions?.includes("messagesDelete")) {
  fail("messagesDelete permission must not be present");
}

const files = [
  ...(manifest?.background?.scripts || []),
  manifest?.action?.default_icon,
  ...Object.values(manifest?.icons || {}),
].filter(Boolean);
for (const file of new Set(files)) {
  if (!existsSync(resolve(root, file))) fail(`manifest references missing file: ${file}`);
}

if (!process.exitCode) console.log("Release validation passed");
