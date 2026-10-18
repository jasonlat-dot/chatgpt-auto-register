import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {acquireLock, ageOn, chooseCode, emailList, inspectMessage, newProfile, runSerial, sleep, validatedCallback} from "../core.mjs";

const since = Date.parse("2026-10-18T10:00:00+08:00");
const guard = () => ({email: "one@mydomain.test", since, baseline: new Set(["before-start"]), used: new Set()});
function message(options = {}) {
  const {id = "new", recipient = "one@mydomain.test", sender = "noreply@tm.openai.com", code = "123456", date = since + 1000, sentAt = date} = options;
  return {id, internalDate: String(date), payload: {mimeType: "multipart/alternative", headers: [
    {name: "From", value: sender}, {name: "To", value: "receiver@gmail.com"}, {name: "X-Original-To", value: recipient}, {name: "Date", value: new Date(sentAt).toUTCString()}
  ], parts: [{mimeType: "text/plain", body: {data: Buffer.from("Your verification code is " + code).toString("base64url")}}]}};
}

test("queue emails deduplicate and reject untouched examples", () => {
  assert.deepEqual(emailList("\uFEFFOne@mydomain.test\none@mydomain.test\n# comment\ntwo@mydomain.test\n"), ["one@mydomain.test", "two@mydomain.test"]);
  assert.throws(() => emailList("first@your-domain.example"));
  assert.throws(() => emailList("not an email"));
});
test("random profiles have calendar-correct birthdays, inclusive 18-50 ages, usable passwords", () => {
  const today = new Date("2026-10-18T12:00:00+08:00");
  const ages = new Set();
  for (let i = 0; i < 1000; i++) {
    const profile = newProfile(today);
    const age = ageOn(profile.birth_date, today);
    assert.equal(age, profile.age_at_creation);
    assert.ok(age >= 18 && age <= 50);
    assert.equal(new Date(profile.birth_date + "T00:00:00Z").toISOString().slice(0, 10), profile.birth_date);
    assert.ok(profile.password.length >= 20);
    ages.add(age);
  }
  assert.ok(ages.has(18) && ages.has(50));
  assert.equal(ageOn("2000-02-29", new Date("2026-02-28T12:00:00Z")), 25);
  assert.equal(ageOn("2000-02-29", new Date("2026-03-01T12:00:00Z")), 26);
});
test("mail matches forwarded original recipient and exactly one new code", () => {
  assert.equal(inspectMessage(message(), guard()).code, "123456");
  const m = message();
  m.payload.headers = m.payload.headers.filter(h => h.name !== "X-Original-To");
  m.payload.headers.find(h => h.name === "To").value = '"User" <ONE@mydomain.test>';
  assert.equal(inspectMessage(m, guard()).code, "123456");
});
test("old, consumed, delayed old forwards, different accounts and lookalike sender are never used", () => {
  const g = guard();
  g.used.add("already-used");
  for (const m of [message({id: "before-start"}), message({id: "already-used"}), message({date: since - 1}), message({sentAt: since - 600000}), message({recipient: "two@mydomain.test"}), message({sender: "noreply@fakeopenai.com"}), message({sender: "noreply@openai.com.evil.test"})]) {
    assert.equal(inspectMessage(m, g).code, undefined);
  }
});
test("missing original recipient and ambiguous digits or multiple new messages require manual handling", () => {
  assert.equal(inspectMessage(message({recipient: "receiver@gmail.com"}), guard()).reason, "recipient");
  assert.equal(inspectMessage(message({code: "123456 and 654321"}), guard()).reason, "ambiguous");
  assert.equal(chooseCode([message({id: "a"}), message({id: "b", code: "654321"})], guard()), null);
  assert.equal(chooseCode([message(), message({id: "other", recipient: "two@mydomain.test"})], guard()).code, "123456");
});
test("OAuth callback validates exact origin/path/state and rejects duplicate code/state", () => {
  const state = "chatgpt2api-test.state";
  const good = "https://platform.openai.com/auth/callback?code=test&state=" + state;
  assert.equal(validatedCallback(good, state), good);
  for (const bad of [good.replace("platform.openai.com", "evil.test"), good.replace("https:", "http:"), good.replace("/callback?", "/callback/other?"), good + "&code=second", good + "&state=other", good.replace(state, "wrong")]) assert.throws(() => validatedCallback(bad, state));
});
test("serial queue has at most one active account, persists before work, and skips imported records", async () => {
  const state = {done: {status: "imported"}};
  let active = 0;
  let maximum = 0;
  const order = [];
  await runSerial(["done", "one", "two"], state, async () => {}, async email => {
    assert.equal(state[email].status, "in_progress");
    active++; maximum = Math.max(maximum, active); order.push(email);
    await sleep(10); active--;
    return {warning: email === "two"};
  });
  assert.equal(maximum, 1);
  assert.deepEqual(order, ["one", "two"]);
  assert.equal(state.one.status, "imported");
  assert.equal(state.two.status, "imported_with_warning");
});
test("failure stops queue, and uncertain token submission is not retried on resume", async () => {
  const state = {};
  const error = Object.assign(new Error("test"), {submitted: true});
  let calls = 0;
  await assert.rejects(runSerial(["one", "two"], state, async () => {}, async () => {calls++; throw error;}));
  assert.equal(state.one.status, "unknown_after_submit");
  assert.equal(state.two, undefined);
  await assert.rejects(runSerial(["one", "two"], state, async () => {}, async () => {calls++;}));
  assert.equal(calls, 1);
});
test("normal pre-submit failure is stopped and user stop does not begin another account", async () => {
  const state = {};
  await assert.rejects(runSerial(["one"], state, async () => {}, async () => {throw new Error("test");}));
  assert.equal(state.one.status, "stopped");
  let calls = 0;
  await runSerial(["two"], state, async () => {}, async () => {calls++;}, () => true);
  assert.equal(calls, 0);
});
test("queue lock rejects a second instance until the first releases it", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "chatgpt2api-queue-test-")), "queue.lock");
  const release = await acquireLock(path);
  await assert.rejects(acquireLock(path), /队列已锁定/);
  await release();
  await (await acquireLock(path))();
});
