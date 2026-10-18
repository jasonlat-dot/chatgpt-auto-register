import test from "node:test";
import assert from "node:assert/strict";
import {callbackAfterNavigation, isOfficialCallback} from "../official-callback.mjs";
import {newAccountPage} from "../browser.mjs";

const state = "chatgpt2api-synthetic-state";
const url = "https://platform.openai.com/auth/callback?code=synthetic&state=" + state;

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
