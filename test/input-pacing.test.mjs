import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {formStep} from "../browser.mjs";
import {typeBirthdayField} from "../birthday.mjs";

function fixture(fields, interruptAt = Infinity, rerenderAt = Infinity) {
  let clock = 0;
  let listener;
  const writes = [];
  const clicks = [];
  class Input {
    constructor(name) {Object.assign(this, {name, type: name === "age" ? "number" : "text", tagName: "INPUT", labels: [], isConnected: true, _value: "", placeholder: ""});}
    get value() {return this._value;}
    set value(value) {this._value = value; writes.push({field: this.name, value, at: clock});}
    getBoundingClientRect() {return {width: 100, height: 30};}
    getAttribute() {return null;}
    focus() {}
    dispatchEvent() {}
  }
  const inputs = fields.map(field => new Input(field));
  const button = {innerText: "继续", getBoundingClientRect: () => ({width: 100, height: 30}), click() {clicks.push(clock);}};
  const context = {location: {hostname: "auth.openai.com", href: "https://auth.openai.com/about-you", pathname: "/about-you"}, window: {}, HTMLInputElement: Input,
    Event: class {}, setTimeout(fn, milliseconds) {
      clock += milliseconds;
      if (clock >= rerenderAt && inputs[0].isConnected) {
        const old = inputs[0];
        const replacement = new Input(old.name);
        replacement._value = old.value;
        old.isConnected = false;
        inputs[0] = replacement;
        rerenderAt = Infinity;
      }
      if (clock >= interruptAt) listener?.({isTrusted: true, target: inputs[0]});
      fn();
    }, document: {readyState: "complete", body: {innerText: ""}, addEventListener(type, fn) {listener = fn;}, removeEventListener() {listener = undefined;},
      querySelectorAll(selector) {return ["input", "input,select", 'input,select,[role="spinbutton"]'].includes(selector) ? inputs : selector === "button,input[type=submit]" ? [button] : [];}}};
  return {context, writes, clicks, run: () => vm.runInNewContext("(" + formStep.toString() + ")({name:'Alex',age:30,birth_date:'1996-01-01'},'',[],{paced:true})", context)};
}

test("paced text is entered one character every 500ms, waits between fields and before Continue", async () => {
  const page = fixture(["name", "age"]);
  assert.equal((await page.run()).kind, "advanced");
  const name = page.writes.filter(item => item.field === "name");
  assert.deepEqual(name.map(item => item.value), ["", "A", "Al", "Ale", "Alex"]);
  assert.deepEqual(name.map(item => item.at), [0, 500, 1000, 1500, 2000]);
  const age = page.writes.filter(item => item.field === "age");
  assert.ok(age[0].at - name.at(-1).at >= 1000);
  assert.deepEqual(age.map(item => item.value), ["", "3", "30"]);
  assert.ok(page.clicks[0] - age.at(-1).at >= 2000);
});

test("manual input during a paced field stops automatic typing and prevents submission", async () => {
  const page = fixture(["name", "age"], 1000);
  assert.equal((await page.run()).kind, "loading");
  assert.deepEqual(page.writes.map(item => item.value), ["", "A"]);
  assert.deepEqual(page.clicks, []);
});

test("a rebuilt input with the identical signature and current value resumes typing without erasing its prefix", async () => {
  const page = fixture(["name", "age"], Infinity, 1000);
  assert.equal((await page.run()).kind, "advanced");
  assert.deepEqual(page.writes.filter(item => item.field === "name").map(item => item.value), ["", "A", "Al", "Ale", "Alex"]);
  assert.equal(page.clicks.length, 1);
});

test("manual input during the pre-submit wait prevents Continue from being clicked", async () => {
  const page = fixture(["name"], 3500);
  assert.equal((await page.run()).kind, "manual-profile");
  assert.deepEqual(page.clicks, []);
});

test("birthday text uses the same fixed character delay and waits after the field", async () => {
  const page = fixture(["birthday"]);
  assert.equal(await vm.runInNewContext("(" + typeBirthdayField.toString() + ")(0,'1996/01/01')", page.context), true);
  assert.deepEqual(page.writes.map(item => item.value), ["", "1", "19", "199", "1996", "1996/", "1996/0", "1996/01", "1996/01/", "1996/01/0", "1996/01/01"]);
  assert.equal(page.writes.at(-1).at, 5000);
});
