import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {driveAccount, summarizeRun, printSummary} from "../account-flow.mjs";
import {runSerial} from "../core.mjs";
import {CodeReader} from "../code-reader.mjs";
import {Gmail} from "../gmail.mjs";
import {resolveCodeFailure} from "../failure-choice.mjs";

function fixture(kind, extra = {}) {
  let clock = 100000;
  let polls = 0;
  const reader = new CodeReader({fresh: async () => {polls++; return []; }}, {failurePolicy: "skip", notify: () => {}, now: () => clock, waitSeconds: 4});
  return {
    page: {callback: null, step: async () => ({kind})},
    job: {email: "one@domain.test"}, reader,
    guard: {since: clock}, used: new Set(), started: {expires_in: 600},
    finish: async () => ({added: 1, skipped: 0}), automatic: true,
    notify: () => {}, now: () => clock, pause: async ms => {clock += ms;},
    elapsed: () => clock - 100000, polls: () => polls,
    ...extra
  };
}

test("automatic flow immediately skips phone/captcha, unsupported profile and manually touched OTP", async () => {
  for (const kind of ["manual-verification", "manual-profile", "otp-manual"]) {
    const f = fixture(kind);
    const result = await driveAccount(f);
    assert.equal(result.skipped, true);
    assert.ok(result.reason.length > 0);
    assert.equal(f.elapsed(), 0);
    assert.equal(f.polls(), 0);
  }
});

test("unknown pages get only a short rendering grace period and stalled pages are skipped", async () => {
  const unknown = fixture("manual");
  assert.equal((await driveAccount(unknown)).skipped, true);
  assert.ok(unknown.elapsed() >= 3000 && unknown.elapsed() < 4000);
  for (const kind of ["loading", "waiting", "otp-waiting"]) {
    const stalled = fixture(kind);
    assert.equal((await driveAccount(stalled)).skipped, true);
    assert.ok(stalled.elapsed() >= 45000 && stalled.elapsed() < 47000);
  }
});

test("automatic OTP timeout and polling failures skip without invoking any dialog", async () => {
  const timeout = fixture("otp");
  assert.match((await driveAccount(timeout)).reason, /超时/);
  assert.ok(timeout.elapsed() < 10000);
  const failed = fixture("otp");
  failed.reader.gmail.fresh = async () => {throw new Error("synthetic");};
  assert.match((await driveAccount(failed)).reason, /取码失败/);
  const pending = {pendingFailure: "no mail"};
  assert.equal(await resolveCodeFailure(pending, {skipManual: true, ask: async () => {throw new Error("dialog must never open");}}), "skip");
  assert.equal(pending.pendingFailure, null);
});

test("temporary loading does not skip a successful callback; successful import and warning are counted", async () => {
  for (const warning of [false, true]) {
    const f = fixture("loading");
    let steps = 0;
    f.page.step = async () => {if (++steps === 3) f.page.callback = "synthetic-callback"; return {kind: "loading"};};
    f.finish = async callback => {assert.equal(callback, "synthetic-callback"); return {added: 1, skipped: 0, errors: warning ? ["refresh"] : []};};
    assert.deepEqual(await driveAccount(f), {warning});
  }
});

test("callback submission failures remain unknown and are never presented as a manual skip", async () => {
  const f = fixture("loading");
  f.page.callback = "synthetic";
  f.finish = async () => {throw new Error("synthetic network error");};
  await assert.rejects(driveAccount(f), error => error.submitted === true);
  f.finish = async () => ({added: 0, skipped: 0});
  await assert.rejects(driveAccount(f), error => error.submitted === true);
});

test("manual mode preserves human intervention while user cancellation always stops automatic mode", async () => {
  const f = fixture("manual-verification", {automatic: false});
  f.pause = async () => {f.page.callback = "manual-completed";};
  assert.deepEqual(await driveAccount(f), {warning: false});
  const controller = new AbortController(); controller.abort();
  await assert.rejects(driveAccount(fixture("manual", {signal: controller.signal})), /停止/);
});

test("five consecutive browser read errors skip the current account", async () => {
  const f = fixture("manual");
  f.page.step = async () => {throw new Error("synthetic page error");};
  assert.match((await driveAccount(f)).reason, /连续无法/);
  assert.equal(f.elapsed(), 4000);
});

test("automatic serial queue continues after skips and account errors; reports only this run and keeps held records", async () => {
  const emails = ["skip", "failed", "unknown", "success", "warning", "old", "oldskip"];
  const state = {old: {status: "unknown_after_submit"}, oldskip: {status: "skipped"}};
  const before = {...state};
  const order = [];
  await runSerial(emails, state, async () => {}, async email => {
    order.push(email);
    try {
      if (email === "skip") return {skipped: true, reason: "phone"};
      if (email === "failed") throw new Error("before submit");
      if (email === "unknown") throw Object.assign(new Error("after submit"), {submitted: true});
      return {warning: email === "warning"};
    } finally {order.push("closed-" + email);}
  }, () => false, {continueOnError: true});
  assert.deepEqual(order, ["skip", "closed-skip", "failed", "closed-failed", "unknown", "closed-unknown", "success", "closed-success", "warning", "closed-warning"]);
  const summary = summarizeRun(emails, before, state);
  assert.deepEqual(summary.counts, {success: 1, warning: 1, skipped: 1, failed: 1, unknown: 1, held: 2, unprocessed: 0});
  assert.equal(summary.items[0].reason, "phone");
  const lines = []; printSummary(summary, line => lines.push(line));
  assert.ok(lines[0].includes("成功 1"));
  assert.ok(lines.includes("skip：phone"));
});

test("cleanup failure stops the queue but preserves a confirmed import; save failure never starts the next account", async () => {
  const state = {};
  let calls = 0;
  await assert.rejects(runSerial(["one", "two"], state, async () => {}, async () => {
    calls++;
    throw Object.assign(new Error("cleanup"), {fatal: true, outcome: {warning: false}});
  }, () => false, {continueOnError: true}));
  assert.equal(state.one.status, "imported");
  assert.equal(calls, 1);
  await assert.rejects(runSerial(["one", "two"], {}, async () => {throw new Error("disk failure");}, async () => {calls++;}, () => false, {continueOnError: true}));
  assert.equal(calls, 1);
});

test("unattended Gmail never opens consent UI when authorization is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cg2-gmail-unattended-"));
  await writeFile(join(dir, "credentials.json"), JSON.stringify({installed: {client_id: "synthetic", client_secret: "synthetic"}}));
  const gmail = new Gmail(join(dir, "credentials.json"), join(dir, "token.json"));
  let asked = false;
  gmail.authorize = async () => {asked = true; throw new Error("no consent UI");};
  const reader = new CodeReader(gmail, {failurePolicy: "skip", notify: () => {}});
  assert.equal(await reader.connect(), null);
  await reader.begin("one@domain.test", new Set(), ["openai.com"]);
  assert.ok(reader.pendingFailure);
  assert.equal(asked, false);
});
