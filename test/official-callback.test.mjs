import test from "node:test";
import assert from "node:assert/strict";
import {callbackAfterNavigation, isOfficialCallback, shouldRefreshOfficialCallback} from "../official-callback.mjs";
import {newAccountPage} from "../browser.mjs";

const state = "chatgpt2api-synthetic-state";
const url = "https://platform.openai.com/auth/callback?code=synthetic&state=" + state;

test("refresh recognizes any official callback with a nonempty code rather than comparing a fixed URL or parameter values", () => {
  const reordered = "https://platform.openai.com/auth/callback?scope=openid%20email&state=" + state + "&code=%73ynthetic#done";
  assert.equal(shouldRefreshOfficialCallback(reordered), true);
  assert.equal(shouldRefreshOfficialCallback(reordered.replace("%73ynthetic", "different").replace(state, "different-state")), true);
  assert.equal(shouldRefreshOfficialCallback("https://platform.openai.com/auth/callback?code=another-code"), true);
  assert.equal(shouldRefreshOfficialCallback("https://platform.openai.com/auth/callback?code="), false);
  assert.equal(shouldRefreshOfficialCallback("https://platform.openai.com/auth/callback?state=anything"), false);
  assert.equal(shouldRefreshOfficialCallback(url + "&code=synthetic"), false);
  assert.equal(shouldRefreshOfficialCallback("https://other.test/auth/callback?code=synthetic"), false);
});

test("import uses the callback that was actually refreshed, while still validating its state after loading", async () => {
  const current = "https://platform.openai.com/auth/callback?code=new-current-code&state=" + state;
  assert.equal(await callbackAfterNavigation(url, state, async () => true, {refreshCurrentCallback: async () => current}), current);
  await assert.rejects(callbackAfterNavigation(url, state, async () => true, {refreshCurrentCallback: async () => current.replace(state, "unrelated-state")}), /state/);
});

test("official callback URL is validated and exposed only after the destination becomes stable", async () => {
  let finishLoad;
  let settled = false;
  const promise = callbackAfterNavigation(url, state, options => {
    assert.equal(options.stableMs, 1000);
    return new Promise(resolve => {finishLoad = resolve;});
  }).then(value => {settled = true; return value;});
  await Promise.resolve();
  assert.equal(settled, false);
  finishLoad(true);
  assert.equal(await promise, url);
});

test("failed load, closed window, cancellation and invalid state never produce an importable callback", async () => {
  await assert.rejects(callbackAfterNavigation(url, state, async () => false), /未加载稳定/);
  await assert.rejects(callbackAfterNavigation(url, state, async () => true, {isClosed: () => true}), /未加载稳定/);
  await assert.rejects(callbackAfterNavigation(url, state, async () => true, {signal: {aborted: true}}), /停止/);
  await assert.rejects(callbackAfterNavigation(url, "wrong-state", async () => true), /state/);
  assert.equal(isOfficialCallback("https://platform.openai.com/auth/callback-else?code=x"), false);
  assert.equal(isOfficialCallback("https://platform.openai.com.evil.test/auth/callback"), false);
});

test("callback refresh runs once before readiness; refresh failure never releases a callback", async () => {
  const events = [];
  assert.equal(await callbackAfterNavigation(url, state, async () => {events.push("ready"); return true;}, {refreshCurrentCallback: async () => events.push("reload")}), url);
  assert.deepEqual(events, ["reload", "ready"]);
  await assert.rejects(callbackAfterNavigation(url, state, async () => {throw new Error("must not inspect readiness");}, {refreshCurrentCallback: async () => {throw new Error("refresh failed");}}), /refresh failed/);
});

test("browser reloads the current callback only once and ignores old document load events", async () => {
  const methods = [];
  let currentUrl = "about:blank";
  const browser = {mode: "normal", listeners: new Set(),
    async send(method) {methods.push(method); return {targetId: "target", sessionId: "session", frameTree: {frame: {id: "main", url: currentUrl}}};},
    async evaluate() {return {ready: true, key: "refreshed-document"};}};
  const page = await newAccountPage(browser, state);
  const emit = (method, params) => {for (const listener of browser.listeners) listener({sessionId: "session", method, params});};
  currentUrl = url;
  emit("Page.frameNavigated", {frame: {id: "main", url}});
  await new Promise(resolve => setTimeout(resolve, 0));
  emit("Page.loadEventFired", {});
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(methods.filter(method => method === "Page.reload").length, 1);
  assert.equal(page.callback, null, "old document becoming ready must not satisfy a pending reload");
  emit("Page.frameNavigated", {frame: {id: "main", url}});
  emit("Page.loadEventFired", {});
  for (let i = 0; i < 30 && !page.callback; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(page.callback, url);
  assert.equal(methods.filter(method => method === "Page.reload").length, 1);
  await page.close();
});

test("browser observes callback requests without Fetch interception and waits for a committed destination", async () => {
  let evaluations = 0;
  const methods = [];
  const browser = {mode: "normal", listeners: new Set(),
    async send(method) {methods.push(method); return {targetId: "target", sessionId: "session", frameTree: {frame: {id: "main"}}};},
    async evaluate() {evaluations++; return {ready: true, key: "destination"};}};
  const page = await newAccountPage(browser, state);
  const emit = (method, params) => {for (const listener of browser.listeners) listener({sessionId: "session", method, params});};
  emit("Network.requestWillBeSent", {type: "Document", frameId: "other", request: {url}});
  assert.equal(page.callback, null);
  emit("Network.requestWillBeSent", {type: "Document", frameId: "main", request: {url}});
  assert.equal(page.callback, null);
  assert.equal(evaluations, 0);
  assert.equal((await page.step({})).kind, "loading");
  emit("Page.frameNavigated", {frame: {id: "main", url: "https://platform.openai.com/after-auth"}});
  assert.equal(page.callback, null);
  emit("Page.loadEventFired", {});
  for (let i = 0; i < 30 && !page.callback; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(page.callback, url);
  assert.ok(evaluations >= 2);
  assert.ok(!methods.some(method => method.startsWith("Fetch.")));
  await page.close();
});

test("address polling recognizes an unreachable callback and confirms a refreshed loader when navigation events are absent", async () => {
  const methods = [], logs = [];
  let frame = {id: "main", url: "about:blank", loaderId: "initial"};
  const browser = {mode: "normal", listeners: new Set(),
    async send(method) {
      methods.push(method);
      if (method === "Page.reload") frame = {id: "main", url, loaderId: "new-after-refresh"};
      return {targetId: "target", sessionId: "session", frameTree: {frame}};
    }, async evaluate() {return {ready: true, key: "new-document"};}};
  const page = await newAccountPage(browser, state, {notify: text => logs.push(text)});
  frame = {id: "main", url: "chrome-error://chromewebdata/", unreachableUrl: url, loaderId: "failed-document"};
  assert.equal((await page.step({})).kind, "loading");
  for (let i = 0; i < 30 && !page.callback; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(page.callback, url);
  assert.equal(methods.filter(method => method === "Page.reload").length, 1);
  assert.ok(logs.some(text => text.includes("地址检查")));
  assert.ok(logs.some(text => text.includes("接受刷新命令")));
  assert.ok(logs.some(text => text.includes("新文档")));
  assert.ok(logs.some(text => text.includes("已加载稳定")));
  assert.ok(logs.every(text => !text.includes(url) && !text.includes(state)));
  await page.close();
});
