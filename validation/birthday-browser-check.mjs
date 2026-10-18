import assert from "node:assert/strict";
import {resolve} from "node:path";
import {launchBrowser, newAccountPage} from "../browser.mjs";
import {sleep} from "../core.mjs";

const job = {email: "synthetic@domain.test", name: "Avery Ellis", birth_date: "1995-03-07", age: 31, password: "synthetic"};
const before = '<!doctype html><meta charset=utf-8><h1>确认一下你的年龄</h1><label>全名<input name="name" autocomplete="name"></label>';
const after = '<button id="continue">继续</button><script>window.submitted=false;document.querySelector("button").onclick=()=>{window.submitted=true;window.submittedName=document.querySelector("input[name=name]").value;window.submittedBirth=document.querySelector("input[name=birthdate],input[name=birthday]")?.value;};</script>';
const segments = '<fieldset><legend>生日日期</legend>' + [
  ["year", "年", 2026, 9999], ["month", "月", 10, 12], ["day", "日", 18, 31]
].map(([part,label,value,max]) => `<span role="spinbutton" contenteditable="true" tabindex="0" data-type="${part}" aria-label="${label}" aria-valuemin="1" aria-valuemax="${max}" aria-valuenow="${value}">${value}</span>`).join('/') + '</fieldset><input type="hidden" name="birthdate" value="2026-10-18"><script>for(const el of document.querySelectorAll("[role=spinbutton]")){el.addEventListener("keydown",e=>{if(e.key==="Backspace"){e.preventDefault();el.dataset.buffer="";el.textContent="";el.removeAttribute("aria-valuenow");}else if(/^[0-9]$/.test(e.key)){e.preventDefault();el.dataset.buffer=(el.dataset.buffer||"")+e.key;el.textContent=String(Number(el.dataset.buffer));el.setAttribute("aria-valuenow",el.textContent);}const values=[...document.querySelectorAll("[role=spinbutton]")].map(x=>(x.getAttribute("aria-valuenow")||"").padStart(2,"0"));document.querySelector("input[name=birthdate]").value=values.join("-");});}</script>';
const cases = [
  {name: "native date prefilled today", html: '<label>出生日期<input type="date" name="birthdate" value="2026-10-18"></label>', expected: job.birth_date},
  {name: "YYYY/MM/DD text prefilled today without placeholder", html: '<label>生日日期<input name="birthday" value="2026/10/18"></label>', expected: "1995/03/07"},
  {name: "MM/DD/YYYY text", html: '<label>Birthday<input name="birthday" placeholder="MM/DD/YYYY" value="10/18/2026"></label>', expected: "03/07/1995"},
  {name: "React-Aria-style contenteditable date segments plus hidden state", html: segments, expected: job.birth_date},
  {name: "controlled state rejects programmatic date change", html: '<label>出生日期<input type="date" name="birthdate" value="2026-10-18"></label><script>document.querySelector("input[name=birthdate]").addEventListener("input",e=>{e.target.value="2026-10-18";});</script>', blocked: true},
  {name: "mismatching serialized hidden birthday", html: '<label>出生日期<input type="date" name="birthdate" value="2026-10-18"></label><input type="hidden" name="birthday" value="2026-10-18">', blocked: true}
];
const browser = await launchBrowser(resolve(import.meta.dirname, "../.local/birthday-test-" + Date.now()), "", true);
try {
  for (const item of cases) {
    const page = await newAccountPage(browser, "chatgpt2api-birthday.state");
    const route = message => {
      if (message.sessionId === page.sessionId && message.method === "Fetch.requestPaused" && message.params.request.url === "https://auth.openai.com/fixture-birthday") {
        void browser.send("Fetch.fulfillRequest", {requestId: message.params.requestId, responseCode: 200, responseHeaders: [{name: "Content-Type", value: "text/html; charset=utf-8"}], body: Buffer.from(before + item.html + after).toString("base64")}, page.sessionId);
      }
    };
    browser.listeners.add(route);
    try {
      await browser.send("Fetch.enable", {patterns: [{urlPattern: "https://auth.openai.com/fixture-birthday", requestStage: "Request"}]}, page.sessionId);
      await page.navigate("https://auth.openai.com/fixture-birthday");
      await sleep(150);
      const result = await page.step(job);
      if (result.kind !== (item.blocked ? "manual-profile" : "advanced")) console.log("DIAGNOSTIC", await browser.evaluate(page.sessionId, "[...document.querySelectorAll('input,[role=spinbutton]')].map(e=>({name:e.name,part:e.getAttribute('data-type'),text:e.textContent,value:e.value,now:e.getAttribute('aria-valuenow'),buffer:e.dataset.buffer}))"));
      assert.equal(result.kind, item.blocked ? "manual-profile" : "advanced", item.name);
      const submitted = await browser.evaluate(page.sessionId, "({submitted:window.submitted,birth:window.submittedBirth,name:window.submittedName})");
      assert.equal(submitted.submitted, !item.blocked, item.name);
      if (!item.blocked) {
        assert.equal(submitted.birth, item.expected, item.name);
        assert.equal(submitted.name, job.name, item.name);
      }
      console.log("PASS: " + item.name + (item.blocked ? "; no incorrect date submitted" : "; generated birthday verified before submit"));
    } finally {browser.listeners.delete(route); await page.close();}
  }
} finally {await browser.close();}
