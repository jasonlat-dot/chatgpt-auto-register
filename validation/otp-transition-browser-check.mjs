import assert from "node:assert/strict";
import {resolve} from "node:path";
import {launchBrowser, newAccountPage} from "../browser.mjs";
import {driveAccount} from "../account-flow.mjs";
import {closeAccountBrowser} from "../page-load.mjs";

// A synthetic OTP button is enabled after rerender, then the profile form spins for twenty seconds.
// All test-tab requests are intercepted; no real service/account is used.
const browser = await launchBrowser(resolve(import.meta.dirname, "../.local/profile-transition-" + Date.now()), "", true, "incognito");
let page;
let route;
let routeError;
let callbackRequestedAt;
const state = "chatgpt2api-synthetic-profile-transition";
const callback = "https://platform.openai.com/auth/callback?code=synthetic&state=" + state;
try {
  page = await newAccountPage(browser, state, {actionDelayMs: 2000});
  const html = `<!doctype html><meta charset=utf-8><input name=code autocomplete=one-time-code maxlength=6><button id=verify disabled>Verify</button><script>
    document.querySelector('input').addEventListener('input',()=>setTimeout(()=>{
      const old=document.querySelector('input'); const replacement=old.cloneNode(true); replacement.value=old.value; old.replaceWith(replacement);
      document.getElementById('verify').disabled=false;
    },1500));
    document.getElementById('verify').onclick=()=>{
      if(document.querySelector('input').value!=='123456') return;
      document.body.innerHTML='<h1>确认一下你的年龄</h1><label>全名<input name=name></label><label>年龄<input name=age type=number></label><button id=next>继续</button>';
      document.getElementById('next').onclick=()=>{
        window.profileSubmittedAt=Date.now();
        document.body.innerHTML='<div>正在处理，请稍候…</div>';
        setTimeout(()=>location.href=${JSON.stringify(callback)},20000);
      };
    };</script>`;
  route = message => {
    if (message.sessionId !== page.sessionId || message.method !== "Fetch.requestPaused") return;
    const {requestId, request} = message.params;
    if (request.url.startsWith("https://platform.openai.com/auth/callback")) {
      callbackRequestedAt = Date.now();
      const response = '<!doctype html><meta charset=utf-8><title>Official callback fixture</title><div role=progressbar>Loading</div><script>setTimeout(()=>document.body.innerHTML="<p>Official page loaded</p>",3000);</script>';
      void browser.send("Fetch.fulfillRequest", {requestId, responseCode: 200, responseHeaders: [{name: "Content-Type", value: "text/html; charset=utf-8"}], body: Buffer.from(response).toString("base64")}, page.sessionId);
      return;
    }
    const known = request.url === "https://auth.openai.com/fixture-profile";
    if (!known && !request.url.endsWith("favicon.ico")) routeError = new Error("Unexpected request blocked");
    void browser.send("Fetch.fulfillRequest", {requestId, responseCode: known ? 200 : 404,
      responseHeaders: [{name: "Content-Type", value: "text/html; charset=utf-8"}], body: Buffer.from(known ? html : "").toString("base64")}, page.sessionId);
  };
  browser.listeners.add(route);
  await browser.send("Fetch.enable", {patterns: [{urlPattern: "*", requestStage: "Request"}]}, page.sessionId);
  await page.navigate("https://auth.openai.com/fixture-profile");
  let imports = 0;
  const began = Date.now();
  const result = await driveAccount({page, job: {email: "owned@domain.test", name: "Synthetic User", age: 30, birth_date: "1996-01-01"},
    guard: {since: began}, used: new Set(), started: {expires_in: 600}, beforeSubmitDelayMs: 1000, notify: () => {},
    reader: {manual: false, pendingFailure: null, resetWait() {}, read: async () => ({id: "synthetic-mail", code: "123456"})},
    finish: async value => {
      assert.equal(value, callback);
      assert.ok(Date.now() - callbackRequestedAt >= 4900);
      assert.equal(await browser.evaluate(page.sessionId, "document.title"), "Official callback fixture");
      imports++; return {added: 1, skipped: 0};
    }});
  if (routeError) throw routeError;
  assert.deepEqual(result, {warning: false});
  assert.ok(Date.now() - began >= 23000);
  assert.equal(imports, 1);
  const waitUntilLoaded = page.waitUntilLoaded.bind(page);
  page.waitUntilLoaded = async options => {
    const ready = await waitUntilLoaded(options);
    assert.equal(await browser.evaluate(page.sessionId, "document.title"), "Official callback fixture");
    return ready;
  };
  await closeAccountBrowser(page, browser, {confirmedImport: true, notify: () => {}});
  page = undefined;
  console.log("PASS: isolated Chrome retries a rebuilt OTP field, submits profile, waits for the destination callback page and its spinner to settle, imports once and keeps the destination page during countdown; synthetic requests only.");
} finally {
  if (route) browser.listeners.delete(route);
  if (page) await page.close();
  await browser.close();
}
