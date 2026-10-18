import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {browserSessionProbe, driveSessionAccount, sessionToken, submitSession} from "../session-import.mjs";
import {newAccountPage, formStep} from "../browser.mjs";

const email = "owned@domain.test";
const now = Date.UTC(2026, 9, 18);
const token = claims => "synthetic." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".signature";
const session = () => ({accessToken: token({email, exp: now / 1000 + 3600}), user: {email}, expires: new Date(now + 3600000).toISOString()});

test("session identity and expiry must match the queued account before any import", () => {
  const valid = session();
  assert.equal(sessionToken(valid, email.toUpperCase(), now), valid.accessToken);
  for (const invalid of [null, {}, {...valid, user: {}}, {...valid, user: {email: "other@domain.test"}},
    {...valid, expires: "bad-date"}, {...valid, expires: new Date(now - 1).toISOString()},
    {...valid, accessToken: token({email: "other@domain.test"})}, {...valid, accessToken: token({exp: now / 1000 - 1})},
    {...valid, accessToken: token({"https://api.openai.com/profile": {email: "other@domain.test"}})},
    {...valid, accessToken: "synthetic.invalid.signature"}]) {
    assert.throws(() => sessionToken(invalid, email, now), error => error.outcome?.skipped && !error.message.includes(valid.accessToken));
  }
});

test("Session import uses the same tokens endpoint as the UI and drops secret response details", async () => {
  const value = session();
  const result = await submitSession(value, email, async (path, body, timeout) => {
    assert.equal(path, "/api/accounts");
    assert.deepEqual(body, {tokens: [value.accessToken]});
    assert.equal(timeout, 180000);
    return {added: 1, skipped: 0, errors: [{error: "sensitive backend detail"}], items: [{email, access_token: "synthetic-rotated"}]};
  }, now);
  assert.deepEqual(result, {added: 1, skipped: 0, errors: [{}]});
  assert.ok(!JSON.stringify(result).includes(value.accessToken));
});

test("duplicate tokens are confirmed, but an absent final account is never recorded as success", async () => {
  const value = session();
  assert.deepEqual(await submitSession(value, email, async () => ({added: 0, skipped: 1, items: [{access_token: value.accessToken}]}), now), {added: 0, skipped: 1, errors: []});
  for (const result of [{added: 1, skipped: 0}, {added: 1, skipped: 0, items: []}, {added: 1, skipped: 0, items: [{email: "other@domain.test"}]}]) {
    await assert.rejects(submitSession(value, email, async () => result, now), /未确认账号仍在池中/);
  }
  let called = false;
  await assert.rejects(submitSession({...value, user: {email: "other@domain.test"}}, email, async () => {called = true;}, now));
  assert.equal(called, false);
});

function fixture(overrides = {}) {
  let clock = now;
  const options = {
    page: {callback: null, readSession: async () => ({kind: "ready", session: session()}), step: async () => ({kind: "waiting"})},
    job: {email}, guard: {since: now}, used: new Set(),
    reader: {pendingFailure: null, manual: false, resetWait() {}, read: async () => null},
    api: async () => ({added: 1, skipped: 0, items: [{email}]}),
    now: () => clock, pause: async () => {clock += 4000;}, ...overrides
  };
  return options;
}

test("an existing authenticated browser imports without requiring Gmail or opening OAuth", async () => {
  let steps = 0;
  const options = fixture({reader: {pendingFailure: "Gmail missing"}});
  options.page.step = async () => {steps++; throw new Error("must not open a login form");};
  assert.deepEqual(await driveSessionAccount(options), {warning: false});
  assert.equal(steps, 0);
  // A normal browser may still be navigating when the first probe runs.
  let probes = 0;
  options.page.readSession = async () => ++probes === 1 ? {kind: "not-on-site"} : {kind: "ready", session: session()};
  options.page.step = async () => ({kind: "loading"});
  options.reader = {pendingFailure: "Gmail missing", resetWait() {}};
  assert.deepEqual(await driveSessionAccount(options), {warning: false});
  assert.equal(probes, 2);
});

test("login and OTP finish before session extraction; one backend submission only", async () => {
  const options = fixture();
  let loggedIn = false;
  let reads = 0;
  let submitted = 0;
  options.page.readSession = async () => loggedIn ? {kind: "ready", session: session()} : {kind: "not-on-site"};
  options.page.step = async (job, code) => {
    if (code === "123456") {loggedIn = true; return {kind: "otp-submitted"};}
    return {kind: "otp"};
  };
  options.reader.read = async () => {reads++; return {id: "synthetic-mail", code: "123456"};};
  options.api = async path => {submitted++; assert.equal(path, "/api/accounts"); return {added: 1, skipped: 0, items: [{email}]};};
  assert.deepEqual(await driveSessionAccount(options), {warning: false});
  assert.equal(reads, 1);
  assert.equal(submitted, 1);
  assert.equal(options.used.has("synthetic-mail"), true);
});

test("wrong-account session is skipped without importing; unavailable session is bounded", async () => {
  const options = fixture();
  let submissions = 0;
  options.api = async () => {submissions++;};
  options.page.readSession = async () => ({kind: "ready", session: {...session(), user: {email: "other@domain.test"}}});
  await assert.rejects(driveSessionAccount(options), error => error.outcome?.skipped && !error.submitted);
  assert.equal(submissions, 0);
  let probes = 0;
  options.page.readSession = async () => {probes++; return {kind: "unavailable"};};
  await assert.rejects(driveSessionAccount(options), error => error.outcome?.skipped && /响应异常/.test(error.message));
  assert.equal(probes, 3);
});

test("phone/captcha and mail failures skip; ambiguous backend submission is held instead of replayed", async () => {
  for (const kind of ["manual-verification", "manual-profile", "otp-manual"]) {
    const options = fixture();
    options.page.readSession = async () => ({kind: "empty"});
    options.page.step = async () => ({kind});
    assert.equal((await driveSessionAccount(options)).skipped, true);
  }
  const options = fixture();
  options.page.readSession = async () => ({kind: "empty"});
  options.page.step = async () => ({kind: "otp"});
  options.reader.pendingFailure = "Gmail unavailable";
  assert.equal((await driveSessionAccount(options)).skipped, true);
  const timeout = fixture({api: async () => {throw new Error("synthetic-secret-response");}});
  await assert.rejects(driveSessionAccount(timeout), error => error.submitted && !error.outcome && !error.message.includes("synthetic-secret-response"));
  const missing = fixture({api: async () => ({added: 1, skipped: 0, items: []})});
  await assert.rejects(driveSessionAccount(missing), error => error.submitted && /未确认/.test(error.message));
});

async function probeWith({origin = "https://chatgpt.com", status = 200, data = {}, text, fail = false} = {}) {
  let requests = 0;
  const result = await vm.runInNewContext("(" + browserSessionProbe.toString() + ")()", {
    location: {origin}, AbortSignal,
    fetch: async (url, options) => {
      requests++;
      assert.equal(url, "/api/auth/session");
      assert.equal(options.credentials, "include");
      assert.equal(options.redirect, "error");
      assert.equal(options.cache, "no-store");
      if (fail) throw new Error("synthetic secret error");
      return {status, ok: status >= 200 && status < 300, text: async () => text ?? JSON.stringify(data)};
    }
  });
  return {result: JSON.parse(JSON.stringify(result)), requests};
}

test("browser probe stays on ChatGPT origin, uses existing cookies, and never returns unrelated session fields", async () => {
  assert.deepEqual(await probeWith({origin: "https://untrusted.test"}), {result: {kind: "not-on-site"}, requests: 0});
  const value = session();
  assert.deepEqual((await probeWith({data: {...value, cookie: "private-cookie", refreshToken: "private-refresh"}})).result, {kind: "ready", session: value});
  assert.equal((await probeWith({})).result.kind, "empty");
  assert.equal((await probeWith({data: {user: null}})).result.kind, "empty");
  assert.equal((await probeWith({status: 401})).result.kind, "empty");
  for (const input of [{status: 403}, {text: "<html>challenge</html>"}, {text: "x".repeat(1048577)}, {data: {user: {email}}}, {fail: true}]) {
    assert.deepEqual((await probeWith(input)).result, {kind: "unavailable"});
  }
});

test("Session browser contexts preserve normal/incognito isolation without OAuth interception", async () => {
  for (const mode of ["normal", "incognito"]) {
    const calls = [];
    const browser = {mode, listeners: new Set(), send: async (method, params) => {
      calls.push({method, params});
      return {browserContextId: "isolated", targetId: "tab", sessionId: "session"};
    }, evaluate: async () => ({kind: "empty"})};
    const page = await newAccountPage(browser, undefined, {sessionImport: true});
    assert.equal(browser.listeners.size, 0);
    assert.equal(calls.some(x => x.method === "Fetch.enable"), false);
    assert.equal(calls.some(x => x.method === "Target.createBrowserContext"), mode === "incognito");
    assert.deepEqual(await page.readSession(), {kind: "empty"});
    await page.close();
    assert.equal(calls.at(-1).method, mode === "incognito" ? "Target.disposeBrowserContext" : "Target.closeTarget");
  }
});

test("Session login does not follow the existing form adapter's signup link", () => {
  let signupClicks = 0;
  const signup = {disabled: false, innerText: "Sign up", getBoundingClientRect: () => ({width: 10, height: 10}), click() {signupClicks++;}};
  const context = {
    location: {href: "https://auth.openai.com/log-in", hostname: "auth.openai.com", pathname: "/log-in"},
    window: {}, document: {readyState: "complete", body: {innerText: "Sign up"}, addEventListener() {}, querySelectorAll: selector => selector === "a" ? [signup] : []}, WeakSet
  };
  const run = preferLogin => vm.runInNewContext("(" + formStep.toString() + ")(" + JSON.stringify({email, birth_date: "1990-01-01"}) + ", '', [], " + JSON.stringify({preferLogin}) + ")", context);
  run(true);
  assert.equal(signupClicks, 0);
  run(false);
  assert.equal(signupClicks, 1);
});
