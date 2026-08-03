import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const locales = ["de", "en", "ru"];
const fail = message => { console.error(`ERROR: ${message}`); process.exitCode = 1; };
const read = file => readFileSync(resolve(root, file), "utf8");
const keysFromMessages = lang => new Set(Object.keys(JSON.parse(read(`_locales/${lang}/messages.json`))));
const localeKeys = Object.fromEntries(locales.map(lang => [lang, keysFromMessages(lang)]));
const reference = localeKeys.de;

for (const lang of locales.slice(1)) {
  for (const key of reference) if (!localeKeys[lang].has(key)) fail(`${lang} is missing locale key: ${key}`);
  for (const key of localeKeys[lang]) if (!reference.has(key)) fail(`${lang} has extra locale key: ${key}`);
}

const required = new Set();
const addMatches = (text, regex) => {
  for (const match of text.matchAll(regex)) required.add(match[1]);
};
addMatches(read("tab/tab.html"), /__MSG_([A-Za-z0-9_@]+)__/g);
addMatches(read("manifest.json"), /__MSG_([A-Za-z0-9_@]+)__/g);
for (const file of ["tab/tab.js", "tab/tab-utilities.js", "shared/utils.js", "background/background.js"]) {
  const source = read(file);
  addMatches(source, /_\(\s*["']([A-Za-z0-9_@]+)["']/g);
  addMatches(source, /browser\.i18n\.getMessage\(\s*["']([A-Za-z0-9_@]+)["']/g);
}

for (const key of required) {
  for (const lang of locales) if (!localeKeys[lang].has(key)) fail(`${lang} is missing referenced key: ${key}`);
}

if (!process.exitCode) console.log(`i18n validation passed (${reference.size} keys, ${required.size} references)`);
