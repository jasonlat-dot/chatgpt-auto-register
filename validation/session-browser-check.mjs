import assert from "node:assert/strict";
import {resolve} from "node:path";
import {launchBrowser, newAccountPage} from "../browser.mjs";
import {driveSessionAccount} from "../session-import.mjs";

// Every request from the isolated test tab is intercepted and answered locally.
// This validates the shipped browser driver, without any real account, password, Gmail or backend.
for (const mode of ["normal", "incognito"]) {
  const browser = await launchBrowser(resolve(import.meta.dirname, "../.local/session-validation-" + mode + "-" + Date.now()), "", true, mode);
  let page;
  let route;
  let loggedIn = false;
  let routeError;
  let submitted = 0;
  const email = "owned@domain.test";
  const accessToken = "synthetic-session-browser-check";
  try {
    page = await newAccountPage(browser, undefined, {sessionImport: true});
    route = message => {
      if (message.sessionId !== page.sessionId || message.method !== "Fetch.requestPaused") return;
      void (async () => {
        const {requestId, request} = message.params;
        const url = new URL(request.url);
        let body = "";
        let contentType = "text/html; charset=utf-8";
        if (url.origin === "https://chatgpt.com" && url.pathname === "/api/auth/session") {
          contentType = "application/json";
          body = JSON.stringify(loggedIn ? {accessToken, user: {email}, expires: new Date(Date.now() + 3600000).toISOString()} : {});
        } else if (url.href === "https://chatgpt.com/auth/login") {
          body = '<!doctype html><meta charset=utf-8><button onclick="location.href=\'https://auth.openai.com/log-in\'">Log in</button>';
        } else if (url.href === "https://auth.openai.com/log-in") {
          body = `<!doctype html><meta charset=utf-8><label>Email<input type=email name=email></label><label>Password<input type=password name=password></label><a href="https://auth.openai.com/signup">Sign up</a><button id=next>Continue</button><script>
            document.getElementById('next').onclick=()=>{
              if(document.querySelector('[name=email]').value!=='${email}' || document.querySelector('[name=password]').value!=='Synthetic-Password') return;
              document.body.innerHTML='<input name=code autocomplete=one-time-code><button id=verify>Continue</button>';
              document.getElementById('verify').onclick=()=>{if(document.querySelector('input').value==='123456') location.href='https://chatgpt.com/fixture-complete';};
            };</script>`;
        } else if (url.href === "https://chatgpt.com/fixture-complete") {
          loggedIn = true;
          body = "<!doctype html><meta charset=utf-8><p>Synthetic authenticated session</p>";
        } else if (request.url.includes("favicon.ico")) {
          contentType = "image/x-icon";
        } else {
          routeError = new Error("Unexpected test-tab request blocked: " + url.origin + url.pathname);
        }
        await browser.send("Fetch.fulfillRequest", {requestId, responseCode: routeError ? 400 : 200,
          responseHeaders: [{name: "Content-Type", value: contentType}], body: Buffer.from(body).toString("base64")}, page.sessionId);
      })().catch(error => {routeError = error;});
    };
    browser.listeners.add(route);
    await browser.send("Fetch.enable", {patterns: [{urlPattern: "*", requestStage: "Request"}]}, page.sessionId);
    await page.navigate("https://chatgpt.com/auth/login");
    const used = new Set();
    const reader = {pendingFailure: null, manual: false, resetWait() {}, read: async () => ({id: "synthetic-mail", code: "123456"})};
    const result = await driveSessionAccount({page, reader, used, guard: {since: Date.now()},
      job: {email, password: "Synthetic-Password", name: "Synthetic User", age: 30, birth_date: "1996-01-01"},
      api: async (path, body) => {
        assert.equal(path, "/api/accounts");
        assert.deepEqual(body, {tokens: [accessToken]});
        submitted++;
        return {added: 1, skipped: 0, items: [{email}]};
      }});
    if (routeError) throw routeError;
    assert.deepEqual(result, {warning: false});
    assert.equal(loggedIn, true);
    assert.equal(submitted, 1);
    assert.equal(used.has("synthetic-mail"), true);
    console.log("PASS (" + mode + "): real isolated browser, synthetic login + OTP + same-context Session fetch + single mock import; all tab requests intercepted; no real service access.");
  } finally {
    if (route) browser.listeners.delete(route);
    if (page) await page.close();
    await browser.close();
  }
}
