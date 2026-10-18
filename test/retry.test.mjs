import assert from "node:assert/strict";
import test from "node:test";
import {planRetry, printQueueStatus, queueStatus} from "../retry.mjs";
import {printSummary, summarizeRun} from "../account-flow.mjs";

const emails = ["new@domain.test", "stopped@domain.test", "skip@domain.test", "unknown@domain.test", "active@domain.test", "done@domain.test"];
function records() {
  return {
    "stopped@domain.test": {status: "stopped", reason: "用户已停止当前任务。", updated_at: "previous", marker: "keep"},
    "skip@domain.test": {status: "skipped", reason: "phone verification"},
    "unknown@domain.test": {status: "unknown_after_submit", reason: "network"},
    "active@domain.test": {status: "in_progress"},
    "done@domain.test": {status: "imported"}
  };
}

test("queue preflight distinguishes pending, retryable, review-required and completed histories", () => {
  const state = records();
  const view = queueStatus(emails, state);
  assert.equal(view.pending_count, 1);
  assert.equal(view.retryable_count, 2);
  assert.equal(view.review_count, 2);
  assert.equal(view.held_count, 4);
  assert.equal(view.items.find(x => x.email === "stopped@domain.test").label, "已停止 / 失败");
  assert.match(view.items.find(x => x.email === "unknown@domain.test").action, /先核对后端账号池/);
});

test("all-held queue explicitly explains no run, no Gmail, menu 8 retry and menu 5 only lock cleanup", () => {
  const lines = [];
  printQueueStatus(queueStatus(["stopped@domain.test"], records()), line => lines.push(line));
  const message = lines.join("\n");
  assert.match(message, /可执行 0/);
  assert.match(message, /已停止 \/ 失败/);
  assert.match(message, /菜单 8/);
  assert.match(message, /菜单 5 只清理锁/);
  assert.match(message, /未连接 Gmail/);
});

test("single retry queues the account without mutating input or losing previous reason and other metadata", () => {
  const state = records();
  const original = structuredClone(state);
  const result = planRetry(emails, state, {email: "STOPPED@domain.test"});
  assert.deepEqual(state, original);
  assert.deepEqual(result.changed, ["stopped@domain.test"]);
  const record = result.state["stopped@domain.test"];
  assert.equal(record.status, "pending");
  assert.equal(record.reason, undefined);
  assert.equal(record.retry_from_status, "stopped");
  assert.equal(record.retry_from_reason, original["stopped@domain.test"].reason);
  assert.equal(record.marker, "keep");
  assert.notEqual(record.updated_at, "previous");
});

test("batch retry resets only failed/stopped/skipped records and holds unknown/in-progress/done", () => {
  const state = records();
  const result = planRetry(emails, state, {allSafe: true});
  assert.deepEqual(result.changed, ["stopped@domain.test", "skip@domain.test"]);
  assert.equal(result.review_count, 2);
  for (const email of ["unknown@domain.test", "active@domain.test", "done@domain.test"]) assert.equal(result.state[email], state[email]);
  assert.equal(result.state["new@domain.test"], undefined);
});

test("unknown and interrupted accounts require explicit review; successful or archived accounts never requeue", () => {
  const state = records();
  for (const email of ["unknown@domain.test", "active@domain.test"]) {
    assert.throws(() => planRetry(emails, state, {email}), /确认未入库/);
    assert.equal(planRetry(emails, state, {email, confirmedNotImported: true}).state[email].status, "pending");
  }
  assert.throws(() => planRetry(emails, state, {email: "done@domain.test", confirmedNotImported: true}), /已经导入/);
  assert.throws(() => planRetry(emails, state, {email: "stopped@domain.test"}, ["stopped@domain.test"]), /已经导入/);
  assert.equal(state["unknown@domain.test"].status, "unknown_after_submit");
});

test("pending retry is a no-op; an address missing from queue or an unrecognized status is refused", () => {
  const state = records();
  assert.deepEqual(planRetry(emails, state, {email: "new@domain.test"}).changed, []);
  assert.throws(() => planRetry(emails, state, {email: "not-in-queue@domain.test"}), /不在 accounts.txt/);
  assert.throws(() => planRetry(["other@domain.test"], {"other@domain.test": {status: "unexpected"}}, {email: "other@domain.test"}), /无法识别/);
});

test("end-of-run summary gives per-account status and next steps, including held prior failures", () => {
  const state = records();
  const lines = [];
  printSummary(summarizeRun(emails, {...state}, state), line => lines.push(line));
  const message = lines.join("\n");
  assert.match(message, /历史记录未重试/);
  assert.match(message, /状态：已停止 \/ 失败；下一步/);
  assert.match(message, /先核对后端账号池/);
  assert.match(message, /菜单 8 可重新排队/);
});
