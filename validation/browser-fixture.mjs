import assert from "node:assert/strict";
import {resolve} from "node:path";
import {launchBrowser, newAccountPage} from "../browser.mjs";
import {sleep} from "../core.mjs";

for (const mode of ["normal", "incognito"]) {
const browser = await launchBrowser(resolve(import.meta.dirname, "../.local/browser-test-" + mode + "-" + Date.now()), "", true, mode);
try {
  const state = "chatgpt2api-synthetic.state";
  const page = await newAccountPage(browser, state);
  const fixture = `<!doctype html><meta charset=utf-8><h1>Create account</h1><label>Email<input type=email name=email></label><label>Password<input type=password name=password></label><label>Name<input name=name></label><label>Age<input name=age type=number></label><button id=next>Continue</button><script>document.getElementById('next').onclick=()=>{window.testValues=[...document.querySelectorAll('input')].map(x=>x.value); document.body.innerHTML='<label>Code<input name=code autocomplete=one-time-code></label><button id=verify>Continue</button>'; document.getElementById('verify').onclick=()=>{window.testCode=document.querySelector('input').value; location.href='https://platform.openai.com/auth/callback?code=synthetic_not_real&state=${state}';};};</script>`;
  const route = message => {
    if (message.sessionId === page.sessionId && message.method === "Fetch.requestPaused" && message.params.request.url.startsWith("https://auth.openai.com/fixture")) {
      void browser.send("Fetch.fulfillRequest", {requestId: message.params.requestId, responseCode: 200, responseHeaders: [{name: "Content-Type", value: "text/html; charset=utf-8"}], body: Buffer.from(fixture).toString("base64")}, page.sessionId);
    }
  };
  browser.listeners.add(route);
  await browser.send("Fetch.enable", {patterns: [{urlPattern: "https://auth.openai.com/fixture*", requestStage: "Request"}, {urlPattern: "https://platform.openai.com/auth/callback*", requestStage: "Request", resourceType: "Document"}]}, page.sessionId);
  await page.navigate("https://auth.openai.com/fixture");
  const job = {email: "synthetic@mydomain.test", name: "Alex Parker", age: 32, password: "Synthetic-Test-Password", birth_date: "1994-03-01"};
  await sleep(300);
  assert.equal((await page.step(job)).kind, "advanced");
  assert.deepEqual(await browser.evaluate(page.sessionId, "window.testValues"), [job.email, job.password, job.name, "32"]);
  assert.equal((await page.step(job)).kind, "otp");
  // Simulate actual keyboard entry. A mail lookup that completes later must not overwrite it.
  await browser.evaluate(page.sessionId, "document.querySelector('input').focus()");
  await browser.send("Input.insertText", {text: "654321"}, page.sessionId);
  assert.equal((await page.step(job)).kind, "otp-manual");
  assert.equal((await page.step(job, "123456")).kind, "otp-manual");
  assert.equal(await browser.evaluate(page.sessionId, "document.querySelector('input').value"), "654321");
  await browser.evaluate(page.sessionId, "document.getElementById('verify').click()");
  for (let n = 0; n < 50 && !page.callback; n++) await sleep(100);
  assert.equal(page.callback, "https://platform.openai.com/auth/callback?code=synthetic_not_real&state=" + state);
  browser.listeners.delete(route);
  await page.close();
  console.log("PASS (" + mode + "): isolated real Edge, mocked registration form, profile fields, real keyboard manual OTP, delayed automatic code cannot overwrite manual input, manual submit resumes pre-request callback capture. No actual signup or email access.");
} finally {await browser.close();}
}
