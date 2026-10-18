import test from "node:test";
import assert from "node:assert/strict";
import {CodeReader} from "../code-reader.mjs";

const fail = async () => {throw new Error("synthetic mail failure");};
test("manual mode never connects to Gmail or reads mail", async () => {
  const reader = new CodeReader({initialize: fail, ids: fail, fresh: fail}, {manual: true, notify: () => {}});
  assert.equal(await reader.connect(), null);
  const guard = await reader.begin("one@domain.test", new Set(), ["openai.com"]);
  assert.equal(guard.baseline.size, 0);
  assert.equal(await reader.read(guard), null);
});
test("Gmail initialization, baseline and polling errors fall back without aborting the browser task", async () => {
  for (const stage of ["initialize", "ids", "fresh"]) {
    const gmail = {async initialize() {return {emailAddress: "test@gmail.test"};}, async ids() {return ["baseline"];}, async fresh() {return [];}};
    gmail[stage] = fail;
    const notes = [];
    const reader = new CodeReader(gmail, {notify: message => notes.push(message)});
    await reader.connect();
    const guard = await reader.begin("one@domain.test", new Set(), ["openai.com"]);
    await reader.read(guard);
    assert.equal(reader.manual, true, stage);
    assert.equal(notes.length, 1, stage);
    assert.match(notes[0], /手动接码/);
    await reader.read(guard);
    assert.equal(notes.length, 1);
  }
});
test("waiting for code times out into manual mode without further mailbox polling", async () => {
  let now = 10000;
  let polls = 0;
  const reader = new CodeReader({async fresh() {polls++; return [];}}, {waitSeconds: 60, now: () => now, notify: () => {}});
  const guard = {email: "one@domain.test", since: 0, baseline: new Set(), used: new Set()};
  assert.equal(await reader.read(guard), null);
  now += 59000;
  await reader.read(guard);
  assert.equal(reader.manual, false);
  now += 1000;
  await reader.read(guard);
  assert.equal(reader.manual, true);
  assert.equal(polls, 2);
});
