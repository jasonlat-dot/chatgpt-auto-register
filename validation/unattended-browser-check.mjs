import assert from "node:assert/strict";
import {resolve} from "node:path";
import {launchBrowser, newAccountPage} from "../browser.mjs";
import {driveAccount} from "../account-flow.mjs";
import {CodeReader} from "../code-reader.mjs";

const browser = await launchBrowser(resolve(import.meta.dirname, "../.local/unattended-browser-test-" + Date.now()), "", true);
try {
  const cases = [
    {html: '<h1>Verify your phone</h1><label>Phone<input type="tel" name="phone"></label>', reason: /手机验证|人机验证/},
    {html: '<label>Favorite color<input name="favoritecolor"></label>', reason: /资料表单/},
    {html: '<h1>Unrecognized step</h1><p>Some unfamiliar content</p>', reason: /无法自动处理/}
  ];
  for (const item of cases) {
    const page = await newAccountPage(browser, "chatgpt2api-unattended.state");
    const route = message => {
      if (message.sessionId === page.sessionId && message.method === "Fetch.requestPaused" && message.params.request.url === "https://auth.openai.com/fixture-unattended") {
        void browser.send("Fetch.fulfillRequest", {requestId: message.params.requestId, responseCode: 200, responseHeaders: [{name: "Content-Type", value: "text/html; charset=utf-8"}], body: Buffer.from('<!doctype html><meta charset=utf-8>' + item.html).toString("base64")}, page.sessionId);
      }
    };
    browser.listeners.add(route);
    try {
      await browser.send("Fetch.enable", {patterns: [{urlPattern: "https://auth.openai.com/fixture-unattended", requestStage: "Request"}]}, page.sessionId);
      await page.navigate("https://auth.openai.com/fixture-unattended");
      const reader = new CodeReader({}, {failurePolicy: "skip", notify: () => {}});
      const result = await driveAccount({page, job: {email: "synthetic@domain.test", name: "Test User", birth_date: "1995-01-01", age: 31, password: "synthetic"}, reader, guard: {since: Date.now()}, used: new Set(), started: {expires_in: 600}, finish: async () => {throw new Error("finish should not be called");}, notify: () => {}});
      assert.equal(result.skipped, true);
      assert.match(result.reason, item.reason);
    } finally {browser.listeners.delete(route); await page.close();}
  }
  console.log("PASS: actual Edge + synthetic phone verification, unsupported profile and unknown page are detected by the real form adapter and automatically skipped; no dialog, signup or email access.");
} finally {await browser.close();}
