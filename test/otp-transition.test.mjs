import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {formStep} from "../browser.mjs";
import {driveAccount} from "../account-flow.mjs";

function otpForm() {
  class Input {
    constructor(value = "") {this._value = value; this.type = "text"; this.name = "code"; this.autocomplete = "one-time-code"; this.maxLength = 6; this.inputMode = "numeric"; this.labels = []; this.writes = 0;}
    get value() {return this._value;}
    set value(value) {this._value = value; this.writes++;}
    getBoundingClientRect() {return {width: 100, height: 30};}
    getAttribute() {return null;}
    dispatchEvent() {}
  }
  let input = new Input();
  let clicks = 0;
  let onInput;
  const button = {disabled: true, innerText: "Verify", getBoundingClientRect: () => ({width: 100, height: 30}), click() {clicks++;}};
  const context = {
    location: {hostname: "auth.openai.com", href: "https://auth.openai.com/email-verification", pathname: "/email-verification"},
    window: {}, HTMLInputElement: Input, Event: class {constructor(type) {this.type = type;}},
    document: {readyState: "complete", body: {innerText: "Enter code"}, addEventListener(type, fn) {if (type === "input") onInput = fn;},
      querySelectorAll: selector => selector === "input" ? [input] : selector === "button,input[type=submit]" ? [button] : []}
  };
  return {
    run: (code = "") => JSON.parse(JSON.stringify(vm.runInNewContext("(" + formStep.toString() + ")({}, " + JSON.stringify(code) + ")", context))),
    enable() {button.disabled = false;},
    rerender() {input = new Input(input.value);},
    manual(value) {input.value = value; onInput({isTrusted: true, target: input});},
    value: () => input.value, clicks: () => clicks, writes: () => input.writes
  };
}

test("OTP is not reported submitted until an enabled button is clicked; rerender retries without overwriting or duplicate clicks", () => {
  const page = otpForm();
  assert.equal(page.run("123456").kind, "otp-ready");
  assert.equal(page.clicks(), 0);
  assert.equal(page.run().kind, "otp-ready");
  assert.equal(page.writes(), 1);
  page.rerender();
  page.enable();
  assert.equal(page.run().kind, "otp-submitted");
  assert.equal(page.writes(), 0);
  assert.equal(page.clicks(), 1);
  assert.equal(page.run("999999").kind, "otp-waiting");
  assert.equal(page.value(), "123456");
  assert.equal(page.clicks(), 1);
});

test("user input before or after automatic OTP filling always prevents automatic submission", () => {
  for (const filled of [false, true]) {
    const page = otpForm();
    page.run(filled ? "123456" : "");
    page.manual("654321");
    page.enable();
    assert.equal(page.run("123456").kind, "otp-manual");
    assert.equal(page.value(), "654321");
    assert.equal(page.clicks(), 0);
  }
});

function flow() {
  let clock = 100000;
  let calls = 0;
  const logs = [];
  const options = {page: {callback: null}, job: {email: "owned@domain.test"},
    reader: {manual: false, pendingFailure: null, resetWait() {}, read: async () => ({id: "synthetic-mail", code: "123456"})},
    guard: {since: clock}, used: new Set(), started: {expires_in: 600}, now: () => clock,
    pause: async ms => {clock += ms;}, notify: line => logs.push(line),
    finish: async () => {calls++; return {added: 1, skipped: 0};}};
  return {options, logs, elapsed: () => clock - 100000, calls: () => calls};
}

test("profile submission followed by a 20-second spinner/unknown transition waits for callback instead of skipping at three seconds", async () => {
  for (const transition of ["manual", "loading"]) {
    const f = flow();
    let first = true;
    f.options.page.step = async () => {
      if (first) {first = false; return {kind: "advanced"};}
      if (f.elapsed() >= 20000) f.options.page.callback = "synthetic-sensitive-callback";
      return {kind: transition};
    };
    assert.deepEqual(await driveAccount(f.options), {warning: false});
    assert.equal(f.calls(), 1);
    assert.ok(f.elapsed() >= 20000 && f.elapsed() < 60000);
    assert.ok(!f.logs.join(" ").includes("synthetic-sensitive-callback"));
    assert.ok(f.logs.some(line => line.includes("后端已确认导入")));
  }
});

test("post-profile transition times out after a bounded minute with a clear reason and no backend submission", async () => {
  const f = flow();
  let first = true;
  f.options.page.step = async () => {if (first) {first = false; return {kind: "advanced"};} return {kind: "manual"};};
  const result = await driveAccount(f.options);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /表单提交后等待跳转超时/);
  assert.ok(f.elapsed() >= 60000 && f.elapsed() < 62000);
  assert.equal(f.calls(), 0);
});

test("disabled OTP button stays pending and its timeout is never reported as an imported account", async () => {
  const f = flow();
  let filled = false;
  f.options.page.step = async (job, code) => {if (code) filled = true; return {kind: filled ? "otp-ready" : "otp"};};
  const result = await driveAccount(f.options);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /提交按钮一直不可用/);
  assert.equal(f.calls(), 0);
  assert.equal(f.options.used.has("synthetic-mail"), true);
});

test("explicit phone/captcha still skips promptly after profile submission", async () => {
  const f = flow();
  let first = true;
  f.options.page.step = async () => {if (first) {first = false; return {kind: "advanced"};} return {kind: "manual-verification"};};
  assert.equal((await driveAccount(f.options)).skipped, true);
  assert.ok(f.elapsed() < 3000);
});
