import assert from "node:assert/strict";
import {resolve} from "node:path";
import {launchBrowser, newAccountPage} from "../browser.mjs";
import {sleep} from "../core.mjs";

for (const redirected of [false, true]) {
  const browser = await launchBrowser(resolve(import.meta.dirname, "../.local/official-navigation-" + Date.now()), "", true);
  let page;
  let route;
  try {
    const productionMethods = [];
    const send = browser.send.bind(browser);
    browser.send = (...args) => {productionMethods.push(args[0]); return send(...args);};
    const state = "chatgpt2api-official-fixture";
    const callback = "https://platform.openai.com/auth/callback?code=synthetic&state=" + state;
    const destination = redirected ? "https://platform.openai.com/fixture-destination" : callback;
    page = await newAccountPage(browser, state);
    assert.ok(!productionMethods.some(method => method.startsWith("Fetch.")));
    let requestedAt;
    let callbackRequests = 0;
    route = message => {
      if (message.sessionId !== page.sessionId || message.method !== "Fetch.requestPaused") return;
      const {requestId, request} = message.params;
      if (request.url === callback) {requestedAt = Date.now(); callbackRequests++;}
      if (redirected && request.url === callback) {
        void send("Fetch.fulfillRequest", {requestId, responseCode: 302, responseHeaders: [{name: "Location", value: destination}], body: ""}, page.sessionId);
        return;
      }
      const known = request.url === destination;
      const html = '<!doctype html><title>Destination fixture</title><div role=progressbar>Loading</div><script>setTimeout(()=>document.body.innerHTML="<p>Destination ready</p>",2000);</script>';
      void send("Fetch.fulfillRequest", {requestId, responseCode: known ? 200 : 404, responseHeaders: [{name: "Content-Type", value: "text/html; charset=utf-8"}], body: Buffer.from(known ? html : "").toString("base64")}, page.sessionId);
    };
    browser.listeners.add(route);
    // The fixture alone supplies responses; production observation never intercepts them.
    await send("Fetch.enable", {patterns: [{urlPattern: "*", requestStage: "Request"}]}, page.sessionId);
    await page.navigate(callback);
    await sleep(500);
    assert.equal(page.callback, null);
    for (let i = 0; i < 100 && !page.callback; i++) await sleep(100);
    assert.equal(page.callback, callback);
    assert.equal(productionMethods.filter(method => method === "Page.reload").length, redirected ? 0 : 1);
    assert.equal(callbackRequests, redirected ? 1 : 2);
    assert.ok(Date.now() - requestedAt >= 2900);
    assert.equal(await browser.evaluate(page.sessionId, "location.href"), destination);
    await page.showImportComplete();
    assert.equal(await browser.evaluate(page.sessionId, "location.href"), destination);
    assert.equal(await browser.evaluate(page.sessionId, "document.title"), "Destination fixture");
    assert.ok(!productionMethods.some(method => method.startsWith("Fetch.")));
    console.log("PASS: " + (redirected ? "redirected destination is not reopened or refreshed" : "current callback reloads exactly once") + "; waits for new document stability before callback release; original page preserved; synthetic requests only.");
  } finally {
    if (route) browser.listeners.delete(route);
    if (page) await page.close();
    await browser.close();
  }
}
