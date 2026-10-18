import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {adminAuthError, apiBase, configuredAdminKey, saveAdminKey, verifyAdminKey} from "../admin-auth.mjs";
import {readJSON, runSerial} from "../core.mjs";

test("saved config key takes priority, with environment fallback and explicit candidate override", () => {
  const config = {chatgpt2api_admin_key: " saved-key "};
  assert.equal(configuredAdminKey(config, "env-key"), "saved-key");
  assert.equal(configuredAdminKey({}, " env-key "), "env-key");
  assert.equal(configuredAdminKey(config, "new-candidate", true), "new-candidate");
  assert.equal(configuredAdminKey({}, undefined), "");
});

test("admin validation uses only the backend login endpoint and rejects ordinary users", async () => {
  const base = apiBase({api_base_url: "http://127.0.0.1:3000"});
  let calls = 0;
  await verifyAdminKey(base, "synthetic-admin", async (url, options) => {
    calls++;
    assert.equal(url.href, "http://127.0.0.1:3000/auth/login");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.authorization, "Bearer synthetic-admin");
    return {ok: true, role: "admin"};
  });
  assert.equal(calls, 1);
  await assert.rejects(verifyAdminKey(base, "", async () => {throw new Error("must not request");}), error => error.code === "ADMIN_KEY_MISSING");
  await assert.rejects(verifyAdminKey(base, "synthetic-user", async () => ({ok: true, role: "user"})), error => error.code === "ADMIN_AUTH_REJECTED");
});

test("401/403 request a new key; network/500/malformed responses do not masquerade as invalid keys", async () => {
  const base = apiBase({});
  for (const status of [401, 403]) await assert.rejects(verifyAdminKey(base, "synthetic", async () => {throw Object.assign(new Error("synthetic-key must not be echoed"), {status});}), error => error.code === "ADMIN_AUTH_REJECTED" && !error.message.includes("synthetic-key"));
  for (const error of [new Error("network unavailable"), Object.assign(new Error("server unavailable"), {status: 500})]) {
    await assert.rejects(verifyAdminKey(base, "synthetic", async () => {throw error;}), received => received === error && received.code !== "ADMIN_AUTH_REJECTED");
  }
  await assert.rejects(verifyAdminKey(base, "synthetic", async () => ({ok: false})), error => error.code !== "ADMIN_AUTH_REJECTED");
});

test("saving a validated key merges latest unrelated config fields and refuses a changed target server", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cg2-admin-key-config-"));
  const path = join(dir, "config.json");
  const config = {api_base_url: "http://127.0.0.1:3000", proxy: "", extra: {nested: {keep: true}}, chatgpt2api_admin_key: "old-synthetic"};
  await writeFile(path, JSON.stringify(config));
  await saveAdminKey(path, "new-synthetic", apiBase(config));
  assert.deepEqual(await readJSON(path), {...config, chatgpt2api_admin_key: "new-synthetic"});
  const changed = {...config, api_base_url: "http://127.0.0.1:4000"};
  await writeFile(path, JSON.stringify(changed));
  await assert.rejects(saveAdminKey(path, "must-not-save", apiBase(config)), /服务地址/);
  assert.deepEqual(await readJSON(path), changed);
});

test("authentication loss before OAuth leaves pending for credential recovery; submitted outcome stays unknown", async () => {
  for (const submitted of [false, true]) {
    const state = {};
    let calls = 0;
    await assert.rejects(runSerial(["one", "two"], state, async () => {}, async () => {
      calls++;
      throw Object.assign(adminAuthError(), {submitted});
    }, () => false, {continueOnError: true}));
    assert.equal(state.one.status, submitted ? "unknown_after_submit" : "pending");
    assert.equal(state.two, undefined);
    assert.equal(calls, 1);
  }
});

test("backend URLs reject credential-bearing URLs and remote plaintext HTTP", () => {
  for (const value of ["http://remote.test", "https://user:password@remote.test", "https://remote.test/path", "https://remote.test/?key=secret"]) assert.throws(() => apiBase({api_base_url: value}));
  assert.equal(apiBase({api_base_url: "https://backend.example"}).href, "https://backend.example/");
});
