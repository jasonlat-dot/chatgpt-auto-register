import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {readBrowserMode, saveBrowserMode, profileForAccount} from "../browser-mode.mjs";
import {newAccountPage} from "../browser.mjs";

test("browser preference defaults to private, persists and supports a per-run override without rewriting", async () => {
  const local = await mkdtemp(join(tmpdir(), "chatgpt2api-browser-mode-"));
  assert.equal(await readBrowserMode(local), "incognito");
  await saveBrowserMode(local, "normal");
  assert.equal(await readBrowserMode(local), "normal");
  assert.equal(await readBrowserMode(local, "incognito"), "incognito");
  assert.equal(await readBrowserMode(local), "normal");
  await assert.rejects(saveBrowserMode(local, "other"), /浏览器模式/);
  assert.equal(await readBrowserMode(local), "normal");
});

test("ordinary profiles are persistent per normalized email; private profiles are always fresh", () => {
  const one = profileForAccount(".local", "ONE@mydomain.test", "normal");
  assert.equal(one, profileForAccount(".local", "one@mydomain.test", "normal"));
  assert.notEqual(one, profileForAccount(".local", "two@mydomain.test", "normal"));
  assert.notEqual(one, profileForAccount(".local", "one@mydomain.test", "incognito"));
  assert.notEqual(profileForAccount(".local", "one@mydomain.test", "incognito"), profileForAccount(".local", "one@mydomain.test", "incognito"));
  assert.doesNotMatch(one, /one@/i);
});

test("ordinary page uses default browser context; private page creates and disposes a separate context", async () => {
  for (const mode of ["normal", "incognito"]) {
    const calls = [];
    const browser = {
      mode, listeners: new Set(),
      async send(method, params = {}) {
        calls.push({method, params});
        if (method === "Target.createBrowserContext") return {browserContextId: "private-id"};
        if (method === "Target.createTarget") return {targetId: "target"};
        if (method === "Target.attachToTarget") return {sessionId: "session"};
        return {};
      }
    };
    const page = await newAccountPage(browser, "chatgpt2api-test.state");
    const target = calls.find(call => call.method === "Target.createTarget");
    assert.equal(target.params.browserContextId, mode === "incognito" ? "private-id" : undefined);
    const fetch = calls.find(call => call.method === "Fetch.enable");
    assert.equal(fetch.params.patterns[0].requestStage, "Request");
    assert.equal(fetch.params.patterns[0].urlPattern, "https://platform.openai.com/auth/callback*");
    await page.close();
    assert.equal(browser.listeners.size, 0);
    assert.equal(calls.at(-1).method, mode === "incognito" ? "Target.disposeBrowserContext" : "Target.closeTarget");
    assert.equal(calls.some(call => call.method === "Target.createBrowserContext"), mode === "incognito");
  }
});
