import assert from "node:assert/strict";
import test from "node:test";
import {resolve} from "node:path";
import {findChrome, chromeArguments} from "../browser-launch.mjs";

test("Chrome search supports system and per-user installs and never falls back to Edge", async () => {
  const visited = [];
  const env = {ProgramFiles: "C:/system", "ProgramFiles(x86)": "C:/system86", LOCALAPPDATA: "C:/user"};
  const userChrome = resolve(env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe");
  const result = await findChrome(env, async path => {
    visited.push(path);
    if (path !== userChrome) throw Object.assign(new Error(), {code: "ENOENT"});
  });
  assert.equal(result, userChrome);
  assert.equal(visited.length, 3);
  assert.ok(visited.every(path => path.endsWith("chrome.exe")));
  await assert.rejects(findChrome(env, async () => {throw Object.assign(new Error(), {code: "ENOENT"});}), /不会自动改用 Edge/);
});

test("native private launch flag follows menu mode while keeping loopback debugging and proxy exclusions", () => {
  const privateArgs = chromeArguments("C:/isolated profile", {proxy: "http://127.0.0.1:7890"});
  assert.ok(privateArgs.includes("--incognito"));
  assert.ok(privateArgs.includes("--user-data-dir=C:/isolated profile"));
  assert.ok(privateArgs.includes("--remote-debugging-address=127.0.0.1"));
  assert.ok(privateArgs.includes("--proxy-bypass-list=localhost;127.0.0.1;[::1]"));
  assert.ok(!chromeArguments("profile", {mode: "normal"}).includes("--incognito"));
  assert.ok(chromeArguments("profile", {headless: true}).includes("--headless=new"));
  assert.throws(() => chromeArguments("profile", {mode: "unknown"}), /浏览器模式/);
});
