import assert from "node:assert/strict";
import {resolve} from "node:path";
import {launchBrowser, newAccountPage} from "../browser.mjs";

for (const sessionImport of [false, true]) {
  const browser = await launchBrowser(resolve(import.meta.dirname, "../.local/input-pacing-" + Date.now()), "", true);
  let page;
  let route;
  try {
    page = await newAccountPage(browser, undefined, {sessionImport, actionDelayMs: 2000});
    const url = sessionImport ? "https://chatgpt.com/auth/login" : "https://auth.openai.com/about-you";
    const fields = sessionImport ? '<input type=email name=email><input type=password name=password>' : '<input name=name><input type=number name=age>';
    const html = '<!doctype html><meta charset=utf-8>' + fields + '<button>继续</button><script>window.trace=[];document.addEventListener("input",e=>trace.push({field:e.target.name,length:e.target.value.length,at:performance.now()}));document.querySelector("button").onclick=()=>{window.clickedAt=performance.now();};</script>';
    route = message => {
      if (message.sessionId !== page.sessionId || message.method !== "Fetch.requestPaused") return;
      const known = message.params.request.url === url;
      void browser.send("Fetch.fulfillRequest", {requestId: message.params.requestId, responseCode: known ? 200 : 404, responseHeaders: [{name: "Content-Type", value: "text/html; charset=utf-8"}], body: Buffer.from(known ? html : "").toString("base64")}, page.sessionId);
    };
    browser.listeners.add(route);
    await browser.send("Fetch.enable", {patterns: [{urlPattern: "*", requestStage: "Request"}]}, page.sessionId);
    await page.navigate(url);
    assert.equal(await page.waitUntilLoaded(), true);
    assert.equal((await page.step({name: "Alex", age: 30, birth_date: "1996-01-01", email: "owned@domain.test", password: "SyntheticOnly123!"})).kind, "advanced");
    const result = await browser.evaluate(page.sessionId, "({trace,clickedAt})");
    const names = [...new Set(result.trace.map(item => item.field))];
    assert.equal(names.length, 2);
    const first = result.trace.filter(item => item.field === names[0]);
    const second = result.trace.filter(item => item.field === names[1]);
    assert.ok(first[0].at >= 1900);
    assert.ok(first.length > 2);
    assert.ok(first[1].at - first[0].at >= 450);
    assert.ok(second[0].at - first.at(-1).at >= 950);
    assert.ok(result.clickedAt - second.at(-1).at >= 1950);
    console.log("PASS: " + (sessionImport ? "Session login" : "OAuth profile") + " waits for the page, types incrementally, pauses between fields and waits before Continue; synthetic requests only.");
  } finally {
    if (route) browser.listeners.delete(route);
    if (page) await page.close();
    await browser.close();
  }
}
