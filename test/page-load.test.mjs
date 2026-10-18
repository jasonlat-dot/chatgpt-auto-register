import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {pageLoadSnapshot, waitForPageLoaded, closeAccountBrowser} from "../page-load.mjs";
import {runSerial} from "../core.mjs";
import {driveSessionAccount} from "../session-import.mjs";
import {newAccountPage} from "../browser.mjs";

test("load snapshot rejects interactive documents and visible loading indicators without exposing form data", () => {
  const element = {getBoundingClientRect: () => ({width: 20, height: 20})};
  const context = {document: {readyState: "interactive", body: {innerText: ""}, querySelectorAll: () => []}, location: {href: "https://auth.openai.com/log-in"}, performance: {timeOrigin: 1}};
  const inspect = () => JSON.parse(JSON.stringify(vm.runInNewContext("(" + pageLoadSnapshot.toString() + ")()", context)));
  assert.equal(inspect().ready, false);
  context.document.readyState = "complete";
  assert.equal(inspect().ready, true);
  context.document.querySelectorAll = selector => selector.includes("progressbar") ? [element] : [];
  assert.equal(inspect().ready, false);
  context.document.querySelectorAll = () => [];
  context.document.body.innerText = "正在处理，请稍候…";
  assert.equal(inspect().ready, false);
});

test("close readiness waits for completion and a stable document, restarting after a redirect", async () => {
  let clock = 0;
  const result = await waitForPageLoaded(async () => clock < 1000 ? {ready: false} : {ready: true, key: clock < 1500 ? "first" : "second"},
    {now: () => clock, pause: async ms => {clock += ms;}, timeoutMs: 5000});
  assert.equal(result, true);
  assert.equal(clock, 2500);
  assert.equal(await waitForPageLoaded(async () => ({closed: true})), true);
});

test("loading and inspection errors time out rather than being treated as a loaded page", async () => {
  for (const inspect of [async () => ({ready: false}), async () => {throw new Error("context destroyed");}]) {
    let clock = 0;
    assert.equal(await waitForPageLoaded(inspect, {now: () => clock, pause: async ms => {clock += ms;}, timeoutMs: 1000}), false);
    assert.equal(clock, 1000);
  }
});

test("normal cleanup waits for page readiness before closing the page and browser", async () => {
  const events = [];
  await closeAccountBrowser({waitUntilLoaded: async () => {events.push("ready"); return true;}, close: async () => events.push("page-closed")},
    {close: async () => events.push("browser-closed")}, {notify: () => {}});
  assert.deepEqual(events, ["ready", "page-closed", "browser-closed"]);
});

test("confirmed OAuth import loads its completion page then counts down three seconds before closing; other outcomes do not wait", async () => {
  for (const confirmedImport of [false, true]) {
    const events = [];
    await closeAccountBrowser({showImportComplete: async () => events.push("completion"), waitUntilLoaded: async () => {events.push("ready"); return true;}, setCloseCountdown: async seconds => events.push(seconds), close: async () => events.push("closed")},
      {close: async () => {}}, {notify: () => {}, confirmedImport, pause: async ms => events.push("wait:" + ms)});
    assert.deepEqual(events, confirmedImport ? ["completion", "ready", 3, "wait:1000", 2, "wait:1000", 1, "wait:1000", "closed"] : ["ready", "closed"]);
  }
});

test("unready or unreadable page is retained, never closed, and raises a fatal queue stop", async () => {
  for (const waitUntilLoaded of [async () => false, async () => {throw new Error("navigation still pending");}]) {
    const events = [];
    await assert.rejects(closeAccountBrowser({waitUntilLoaded, close: async () => events.push("page-closed")},
      {detach: async () => events.push("retained"), close: async () => events.push("browser-closed")}, {notify: () => {}}), error => error.fatal && error.browserRetained);
    assert.deepEqual(events, ["retained"]);
  }
  const events = [];
  await assert.rejects(closeAccountBrowser({waitUntilLoaded: async () => true, close: async () => {throw new Error("target changed");}},
    {detach: async () => events.push("retained"), close: async () => events.push("browser-closed")}, {notify: () => {}}), error => error.browserRetained);
  assert.deepEqual(events, ["retained"]);
});

test("retaining a window stops the next account and preserves an already confirmed import outcome", async () => {
  const state = {};
  let calls = 0;
  await assert.rejects(runSerial(["one", "two"], state, async () => {}, async () => {
    calls++;
    try {await closeAccountBrowser({waitUntilLoaded: async () => false}, {detach: async () => {}}, {notify: () => {}});}
    catch (error) {error.outcome = {warning: false}; throw error;}
  }, () => false, {continueOnError: true}));
  assert.equal(calls, 1);
  assert.equal(state.one.status, "imported");
  assert.equal(state.two, undefined);
});

test("Session load probes do not count as failed Session responses during password-to-OTP navigation", async () => {
  let clock = 100000;
  let probes = 0;
  const result = await driveSessionAccount({page: {callback: null, step: async () => ({kind: "loading"}), readSession: async () => ++probes < 5 ? {kind: "loading"} : {kind: "ready", session: {accessToken: "synthetic-token", user: {email: "owned@domain.test"}}}},
    job: {email: "owned@domain.test"}, guard: {since: clock}, used: new Set(), reader: {manual: false, pendingFailure: null, resetWait() {}},
    now: () => clock, pause: async ms => {clock += Math.max(ms, 3000);}, notify: () => {},
    api: async () => ({added: 1, skipped: 0, items: [{email: "owned@domain.test"}]})});
  assert.deepEqual(result, {warning: false});
  assert.equal(probes, 5);
});

test("main-frame navigation blocks form operations and Session probing until the load event", async () => {
  let evaluations = 0;
  const browser = {mode: "normal", listeners: new Set(), send: async method => ({targetId: "target", sessionId: "session", frameTree: {frame: {id: "main"}}}),
    evaluate: async (id, expression) => {evaluations++; return expression.includes("pageLoadSnapshot") ? {ready: true, key: "synthetic"} : {kind: "empty"};}};
  const page = await newAccountPage(browser, undefined, {sessionImport: true});
  for (const listener of browser.listeners) listener({sessionId: "session", method: "Page.frameStartedLoading", params: {frameId: "main"}});
  assert.equal((await page.step({})).kind, "loading");
  assert.equal((await page.readSession()).kind, "loading");
  assert.equal(evaluations, 0);
  for (const listener of browser.listeners) listener({sessionId: "session", method: "Page.frameStoppedLoading", params: {frameId: "main"}});
  assert.equal((await page.readSession()).kind, "empty");
  await page.close();
});
