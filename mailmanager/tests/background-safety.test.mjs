import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const backgroundSource = await readFile(new URL("../background/background.js", import.meta.url), "utf8");

function storageArea(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(keys) {
      const wanted = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(wanted.filter(Boolean).map(key => [key, store.get(key)]));
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) store.set(key, value);
    },
    async remove(key) {
      store.delete(key);
    },
  };
}

function loadBackground({ protectedEmails = [], protectedFolderIds = [], failUpdateIds = [], failMoveIds = [] } = {}) {
  const calls = { moves: [], updates: [], deletes: [] };
  const failedUpdateIds = new Set(failUpdateIds);
  const failedMoveIds = new Set(failMoveIds);
  const movedListeners = new Set();
  const messages = new Map([
    [1, { id: 1, author: "Protected <protected@example.test>", folder: { id: "inbox" }, tags: [] }],
    [2, { id: 2, author: "Regular <regular@example.test>", folder: { id: "inbox" }, tags: [] }],
  ]);
  const local = storageArea({ protectedEmails, protectedFolderIds });
  const session = storageArea();

  const browser = {
    action: { onClicked: { addListener() {} } },
    tabs: { create() {} },
    runtime: {
      getURL: path => path,
      getManifest: () => ({ name: "MailManager", version: "0.1.0", manifest_version: 3 }),
      sendMessage: async () => ({}),
      onMessage: { addListener() {} },
    },
    storage: { local, session },
    accounts: {
      async list() {
        return [{
          id: "account-1",
          rootFolder: {
            id: "root",
            subFolders: [
              { id: "inbox", name: "Inbox", type: "inbox", subFolders: [] },
              { id: "newsletter", name: "Newsletter", subFolders: [] },
              { id: "trash", name: "Trash", type: "trash", subFolders: [] },
            ],
          },
        }];
      },
    },
    folders: { async create(parentId, name) { return { id: name, name }; } },
    messages: {
      onMoved: {
        addListener(listener) { movedListeners.add(listener); },
        removeListener(listener) { movedListeners.delete(listener); },
      },
      async get(id) {
        const message = messages.get(id);
        if (!message) throw new Error("missing message");
        return { ...message, tags: [...message.tags] };
      },
      async move(ids, destinationId) {
        calls.moves.push({ ids: [...ids], destinationId });
        if (ids.some(id => failedMoveIds.has(id))) throw new Error("move failed");
        const moved = ids.map(id => ({ ...messages.get(id), id: id + 1000 }));
        queueMicrotask(() => {
          for (const listener of movedListeners) {
            listener(
              { messages: ids.map(id => ({ ...messages.get(id), id })) },
              { messages: moved }
            );
          }
        });
      },
      async update(id, changes) {
        calls.updates.push({ id, changes });
        if (failedUpdateIds.has(id)) throw new Error("update failed");
        const message = messages.get(id);
        messages.set(id, { ...message, ...changes });
      },
      async delete(ids) {
        calls.deletes.push([...ids]);
      },
    },
  };

  const context = vm.createContext({
    browser,
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    URL,
    URLSearchParams,
  });
  vm.runInContext(backgroundSource, context, { filename: "background.js" });
  return { context, calls, messages, session };
}

describe("background action safety", () => {
  it("blocks trash for a protected sender before moving messages", async () => {
    const { context, calls } = loadBackground({ protectedEmails: ["protected@example.test"] });

    const result = await context.handlePerformAction("trash", [1], "account-1", "inbox", {}, 11);

    assert.match(result.error, /geschützt/i);
    assert.equal(calls.moves.length, 0);
  });

  it("blocks actions in a protected source folder", async () => {
    const { context, calls } = loadBackground({ protectedFolderIds: ["inbox"] });

    const result = await context.handlePerformAction("trash", [2], "account-1", "inbox", {}, 11);
    const archiveResult = await context.handlePerformAction("archive", [2], "account-1", "inbox", {}, 11);

    assert.match(result.error, /Ordner.*geschützt/i);
    assert.match(archiveResult.error, /Ordner.*geschützt/i);
    assert.equal(calls.moves.length, 0);
  });

  it("uses each message's real folder instead of the UI folder id", async () => {
    const { context, calls, messages } = loadBackground({ protectedFolderIds: ["protected"] });
    messages.get(2).folder = { id: "protected" };

    const result = await context.handlePerformAction(
      "tag", [2], "account-1", "inbox", { tagKey: "tag-a" }, 11
    );

    assert.match(result.error, /Ordner.*geschützt/i);
    assert.equal(calls.updates.length, 0);
  });

  it("fails closed when real folder metadata is unavailable", async () => {
    const { context, calls, messages } = loadBackground({ protectedFolderIds: ["protected"] });
    delete messages.get(2).folder;

    const result = await context.handlePerformAction(
      "tag", [2], "account-1", "inbox", { tagKey: "tag-a" }, 11
    );

    assert.match(result.error, /Ordner.*nicht sicher geprüft/i);
    assert.equal(calls.updates.length, 0);
  });

  it("never moves sender-group IDs outside the authorized message list", async () => {
    const { context, calls } = loadBackground({ protectedEmails: ["protected@example.test"] });

    await context.handlePerformAction("trash", [2], "account-1", "inbox", {
      senderGroups: [{ email: "protected@example.test", messageIds: [1] }],
      olderThanDays: 1,
    }, 11);

    assert.deepEqual(calls.moves.flatMap(call => call.ids), [2]);
  });

  it("keeps undo entries isolated per MailManager tab", async () => {
    const { context, messages, session } = loadBackground();
    messages.get(1).tags = ["tag-a"];

    await context.handleMessage({
      action: "performAction", type: "tag", messageIds: [1],
      accountId: "account-1", folderId: "inbox", options: { tagKey: "tag-a" },
    }, 11);
    await context.handleMessage({
      action: "performAction", type: "tag", messageIds: [2],
      accountId: "account-1", folderId: "inbox", options: { tagKey: "tag-b" },
    }, 22);

    assert.equal(session.store.get("undoEntry:11").messageIds.length, 0);
    assert.equal(session.store.get("undoEntry:22").messageIds[0], 2);

    await context.handleMessage({ action: "undo" }, 11);

    assert.equal(messages.get(1).tags.includes("tag-a"), true);
    assert.deepEqual([...messages.get(2).tags], ["tag-b"]);
    assert.equal(session.store.has("undoEntry:11"), false);
    assert.equal(session.store.has("undoEntry:22"), true);
    await context.handleMessage({ action: "undo" }, 22);
    assert.equal(messages.get(2).tags.length, 0);

    messages.get(1).read = true;
    messages.get(2).read = false;
    await context.handleMessage({
      action: "performAction", type: "markAsRead", messageIds: [1, 2],
      accountId: "account-1", folderId: "inbox", options: {},
    }, 11);
    await context.handleMessage({ action: "undo" }, 11);

    assert.equal(messages.get(1).read, true);
    assert.equal(messages.get(2).read, false);
  });

  it("keeps tag and read undo state when a later update fails", async () => {
    const tag = loadBackground({ failUpdateIds: [2] });
    const tagResult = await tag.context.handlePerformAction(
      "tag", [1, 2], "account-1", "inbox", { tagKey: "tag-a" }, 11
    );

    assert.deepEqual([...tag.session.store.get("undoEntry:11").messageIds], [1]);
    assert.equal(tagResult.taggedCount, 1);
    assert.equal(tagResult.failedCount, 1);
    assert.equal(tag.messages.get(1).tags.includes("tag-a"), true);
    assert.equal(tag.messages.get(2).tags.includes("tag-a"), false);

    const read = loadBackground({ failUpdateIds: [2] });
    read.messages.get(1).read = true;
    read.messages.get(2).read = false;
    const readResult = await read.context.handlePerformAction(
      "markAsRead", [1, 2], "account-1", "inbox", {}, 11
    );

    assert.deepEqual(
      JSON.parse(JSON.stringify(read.session.store.get("undoEntry:11").previousReadState)),
      [{ id: 1, read: true }]
    );
    assert.equal(readResult.markedCount, 1);
    assert.equal(readResult.failedCount, 1);
    assert.equal(read.messages.get(1).read, true);
    assert.equal(read.messages.get(2).read, false);
  });

  it("restores each moved message to its original folder and continues after an undo failure", async () => {
    const { context, calls, messages, session } = loadBackground({ failMoveIds: [1002] });
    messages.get(2).folder = { id: "newsletter" };

    await context.handlePerformAction("trash", [1, 2], "account-1", "inbox", {}, 11);

    assert.deepEqual(
      JSON.parse(JSON.stringify(session.store.get("undoEntry:11").restoreGroups)),
      [
        { sourceFolderId: "inbox", messageIds: [1001] },
        { sourceFolderId: "newsletter", messageIds: [1002] },
      ]
    );

    const undoResult = await context.handleUndo(11);

    assert.equal(undoResult.failedCount, 1);
    assert.deepEqual(calls.moves.slice(1), [
      { ids: [1001], destinationId: "inbox" },
      { ids: [1002], destinationId: "newsletter" },
    ]);
  });

  it("fails closed when the sender has no tab id", async () => {
    const { context, calls, session } = loadBackground();

    const action = await context.handlePerformAction(
      "tag", [2], "account-1", "inbox", { tagKey: "tag-a" }, undefined
    );
    const undo = await context.handleUndo(undefined);

    assert.match(action.error, /Tab/i);
    assert.match(undo.error, /Tab/i);
    assert.equal(calls.updates.length, 0);
    assert.equal(session.store.size, 0);
  });

  it("rejects the unreachable permanent-delete action", async () => {
    const { context, calls } = loadBackground();

    const result = await context.handlePerformAction("delete", [2], "account-1", "inbox", {}, 11);

    assert.match(result.error, /Unbekannte Aktion/);
    assert.equal(calls.deletes.length, 0);
  });
});

it("does not request permanent-delete permission", async () => {
  const { context } = loadBackground();
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.permissions.includes("messagesDelete"), false);
  assert.equal(context.parseListUnsubscribeHeader("<http://example.test/unsub>").kind, "none");
  assert.equal(context.parseListUnsubscribeHeader("<https://example.test/unsub>").kind, "https");
});

it("matches shared bulk scoring for diacritic-insensitive subjects", () => {
  const { context } = loadBackground();
  const result = context.computeBulkScore("info@example.test", "", ["Neue Angebote"]);

  assert.equal(result.isBulkCandidate, true);
  assert.ok(result.bulkReasons.includes("angebot"));
});
