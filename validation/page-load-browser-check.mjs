import assert from "node:assert/strict";
import {resolve} from "node:path";
import {launchBrowser, newAccountPage} from "../browser.mjs";
import {closeAccountBrowser} from "../page-load.mjs";

for (const mode of ["normal", "incognito"]) {
  const browser = await launchBrowser(resolve(import.meta.dirname, "../.local/load-check-" + mode + "-" + Date.now()), "", true, mode);
  let page;
  let route;
  try {
    page = await newAccountPage(browser, undefined, {sessionImport: true});
    const html = '<!doctype html><meta charset=utf-8><div role="progressbar">正在处理，请稍候…</div><script>setTimeout(()=>document.body.innerHTML="<p>Loaded</p>",3000);</script>';
    route = message => {
      if (message.sessionId !== page.sessionId || message.method !== "Fetch.requestPaused") return;
      const {requestId, request} = message.params;
      const known = request.url === "https://auth.openai.com/fixture-load";
      void browser.send("Fetch.fulfillRequest", {requestId, responseCode: known ? 200 : 404,
        responseHeaders: [{name: "Content-Type", value: "text/html; charset=utf-8"}], body: Buffer.from(known ? html : "").toString("base64")}, page.sessionId);
    };
    browser.listeners.add(route);
    await browser.send("Fetch.enable", {patterns: [{urlPattern: "*", requestStage: "Request"}]}, page.sessionId);
    const began = Date.now();
    await page.navigate("https://auth.openai.com/fixture-load");
    assert.equal((await page.step({})).kind, "loading");
    await closeAccountBrowser(page, browser, {notify: () => {}});
    assert.ok(Date.now() - began >= 3900, "must wait for spinner to finish plus document stability before closing");
    console.log("PASS (" + mode + "): real isolated Edge stays open through a visible loading spinner and closes only after the page becomes ready and stable; all tab requests intercepted.");
    page = undefined;
  } finally {
    if (route) browser.listeners.delete(route);
    if (page) await page.close();
    await browser.close();
  }
}
