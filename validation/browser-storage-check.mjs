import assert from "node:assert/strict";
import {resolve} from "node:path";
import {launchBrowser, newAccountPage} from "../browser.mjs";
import {sleep} from "../core.mjs";

const html = "<!doctype html><meta charset=utf-8><p>fixture-storage</p>";
async function visit(browser) {
  const page = await newAccountPage(browser, "chatgpt2api-storage.state");
  const route = message => {
    if (message.sessionId === page.sessionId && message.method === "Fetch.requestPaused" && message.params.request.url === "https://auth.openai.com/fixture-storage") {
      void browser.send("Fetch.fulfillRequest", {requestId: message.params.requestId, responseCode: 200, responseHeaders: [{name: "Content-Type", value: "text/html; charset=utf-8"}], body: Buffer.from(html).toString("base64")}, page.sessionId);
    }
  };
  browser.listeners.add(route);
  await browser.send("Fetch.enable", {patterns: [{urlPattern: "https://auth.openai.com/fixture-storage", requestStage: "Request"}]}, page.sessionId);
  await page.navigate("https://auth.openai.com/fixture-storage");
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {ready = await browser.evaluate(page.sessionId, 'document.body?.textContent === "fixture-storage"');} catch {}
    if (ready) break;
    await sleep(50);
  }
  assert.ok(ready);
  return {
    async read() {return browser.evaluate(page.sessionId, '({cookie: document.cookie, storage: localStorage.getItem("cg2_fixture")})');},
    async mark() {await browser.evaluate(page.sessionId, 'document.cookie="cg2_fixture=persist;Max-Age=3600;Secure;SameSite=Lax";localStorage.setItem("cg2_fixture","persist")');},
    async close() {browser.listeners.delete(route); await page.close();}
  };
}

for (const mode of ["normal", "incognito"]) {
  const profile = resolve(import.meta.dirname, "../.local/storage-test-" + mode + "-" + Date.now());
  let browser = await launchBrowser(profile, "", false, mode);
  try {
    const first = await visit(browser);
    assert.deepEqual(await first.read(), {cookie: "", storage: null});
    await first.mark();
    assert.deepEqual(await first.read(), {cookie: "cg2_fixture=persist", storage: "persist"});
    // Keep one window alive while testing a second context in the same process.
    // Closing the final native private window ends Chrome itself.
    const second = await visit(browser);
    await first.close();
    const expected = mode === "normal" ? {cookie: "cg2_fixture=persist", storage: "persist"} : {cookie: "", storage: null};
    assert.deepEqual(await second.read(), expected);
    await second.close();
    await browser.close();
    await browser.close(); // Closing twice must not repeat a shutdown wait or touch another process.
    browser = await launchBrowser(profile, "", false, mode);
    const reopened = await visit(browser);
    assert.deepEqual(await reopened.read(), expected);
    await reopened.close();
    console.log("PASS (" + mode + "): real Chrome cookies/localStorage " + (mode === "normal" ? "persist across pages and process restart" : "absent in separate contexts and after process restart") + "; synthetic page only.");
  } finally {await browser.close();}
}
