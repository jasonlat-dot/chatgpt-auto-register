import test from "node:test";
import assert from "node:assert/strict";
import {CodeReader} from "../code-reader.mjs";
import {resolveCodeFailure} from "../failure-choice.mjs";
import {runSerial} from "../core.mjs";

const readerWithFailure = () => {
  const reader = new CodeReader({}, {notify: () => {}});
  reader.fail("synthetic failure");
  return reader;
};
test("failure choice always asks with a 15-second timeout; manual choice keeps the current task", async () => {
  const reader = readerWithFailure();
  const result = await resolveCodeFailure(reader, {email: "one@domain.test", ask: async options => {
    assert.equal(options.timeoutSeconds, 15);
    assert.equal(options.email, "one@domain.test");
    return "manual";
  }});
  assert.equal(result, "manual");
  assert.equal(reader.manual, true);
  assert.equal(reader.pendingFailure, null);
});
test("dismissal, timeout and unexpected helper results resolve to skip, while user stop remains stop", async () => {
  for (const answer of ["skip", "", "unexpected"]) {
    assert.equal(await resolveCodeFailure(readerWithFailure(), {ask: async () => answer}), "skip");
  }
  assert.equal(await resolveCodeFailure(readerWithFailure(), {ask: async () => "stop"}), "stop");
});
test("a choice only affects this account; next account attempts automatic mail again", async () => {
  let calls = 0;
  const reader = new CodeReader({async ids() {calls++; return [];}}, {notify: () => {}});
  reader.fail("failed current account");
  await resolveCodeFailure(reader, {ask: async () => "manual"});
  await reader.begin("next@domain.test", new Set(), ["openai.com"]);
  assert.equal(reader.manual, false);
  assert.equal(calls, 1);
});
test("user already typing manually clears the pending popup request", async () => {
  const reader = readerWithFailure();
  reader.useManual("user typed code");
  assert.equal(await resolveCodeFailure(reader, {ask: async () => {throw new Error("must not ask");}}), "continue");
});
test("skipping an account records it and begins the next only after the current task cleanup", async () => {
  const state = {};
  const order = [];
  await runSerial(["one", "two"], state, async () => {}, async email => {
    order.push(email + ":start");
    try {return email === "one" ? {skipped: true} : {};}
    finally {order.push(email + ":close");}
  });
  assert.equal(state.one.status, "skipped");
  assert.equal(state.two.status, "imported");
  assert.deepEqual(order, ["one:start", "one:close", "two:start", "two:close"]);
  await runSerial(["one", "two"], state, async () => {}, async () => {throw new Error("must not retry skipped/imported records");});
});
