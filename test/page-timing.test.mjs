import test from "node:test";
import assert from "node:assert/strict";
import {waitForStablePage} from "../page-timing.mjs";
import {driveAccount} from "../account-flow.mjs";

test("OAuth action delay starts after a rendered form is observed and rechecks navigation/form changes", async () => {
  for (const snapshots of [
    [{ready: true, key: "form-a"}, {ready: true, key: "form-a"}],
    [{ready: true, key: "form-a"}, {ready: true, key: "form-b"}],
    [{ready: true, key: "form-a"}, {ready: false}],
    [{ready: false}]
  ]) {
    const initial = [...snapshots];
    const waits = [];
    const browser = {evaluate: async () => snapshots.shift()};
    const ready = await waitForStablePage(browser, "synthetic", 2000, {pause: async ms => waits.push(ms)});
    assert.equal(ready, initial.length === 2 && initial[1].ready && initial[0].key === initial[1].key);
    assert.deepEqual(waits, initial[0].ready ? [2000] : []);
    assert.equal(snapshots.length, 0);
  }
});

test("cancelling during the two-second delay prevents any subsequent page action", async () => {
  const controller = new AbortController();
  let probes = 0;
  await assert.rejects(waitForStablePage({evaluate: async () => {probes++; return {ready: true, key: "form"};}}, "synthetic", 2000,
    {signal: controller.signal, pause: async () => controller.abort()}), /停止/);
  assert.equal(probes, 1);
});

function accountOptions(extra = {}) {
  return {page: {callback: "synthetic-callback", step: async () => {throw new Error("must not fill a form after callback");}},
    job: {email: "owned@domain.test"}, reader: {}, guard: {since: Date.now()}, used: new Set(), started: {expires_in: 600},
    beforeSubmitDelayMs: 1000, notify: () => {}, ...extra};
}

test("callback capture waits one second before submitting, and completion waits for backend confirmation", async () => {
  const events = [];
  let release;
  const response = new Promise(resolve => {release = resolve;});
  const promise = driveAccount(accountOptions({pause: async ms => {events.push(["wait", ms]);}, finish: async callback => {
    assert.equal(callback, "synthetic-callback"); events.push(["submit"]); await response; events.push(["confirmed"]);
    return {added: 1, skipped: 0};
  }})).then(result => {events.push(["returned"]); return result;});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, [["wait", 1000], ["submit"]]);
  release();
  assert.deepEqual(await promise, {warning: false});
  assert.deepEqual(events, [["wait", 1000], ["submit"], ["confirmed"], ["returned"]]);
});

test("stopping during the callback delay never submits or marks the result unknown", async () => {
  const controller = new AbortController();
  let submits = 0;
  await assert.rejects(driveAccount(accountOptions({signal: controller.signal, pause: async () => controller.abort(),
    finish: async () => {submits++;}})), error => !error.submitted && /停止/.test(error.message));
  assert.equal(submits, 0);
});
