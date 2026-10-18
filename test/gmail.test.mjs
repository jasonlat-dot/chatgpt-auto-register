import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Gmail, jsonRequest} from "../gmail.mjs";

test("Gmail adapter paginates, skips baseline messages, and fetches full new message details", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gmail-queue-api-test-"));
  const client = join(directory, "client.json");
  const token = join(directory, "token.json");
  await writeFile(client, JSON.stringify({installed: {client_id: "synthetic-client", client_secret: "synthetic-client-secret"}}));
  await writeFile(token, JSON.stringify({client_id: "synthetic-client", access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_at: Date.now() + 3600000}));
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (raw, options) => {
    const url = new URL(raw);
    requests.push(url);
    assert.equal(options.headers.authorization, "Bearer synthetic-access");
    let result;
    if (url.pathname.endsWith("/profile")) result = {emailAddress: "synthetic@gmail.test"};
    else if (url.pathname.endsWith("/messages/new")) {assert.equal(url.searchParams.get("format"), "full"); result = {id: "new", payload: {}};}
    else if (url.searchParams.get("pageToken")) result = {messages: [{id: "new"}]};
    else result = {messages: [{id: "baseline"}], nextPageToken: "page-two"};
    return new Response(JSON.stringify(result), {status: 200, headers: {"content-type": "application/json"}});
  };
  try {
    const gmail = new Gmail(client, token);
    assert.equal((await gmail.initialize()).emailAddress, "synthetic@gmail.test");
    const found = await gmail.fresh({baseline: new Set(["baseline"]), used: new Set()});
    assert.deepEqual(found.map(x => x.id), ["new"]);
    assert.equal(requests.some(x => x.pathname.endsWith("/messages/baseline")), false);
    assert.ok(requests.every(x => x.origin === "https://gmail.googleapis.com"));
  } finally {globalThis.fetch = originalFetch;}
});

test("expired Gmail credentials refresh through the expected endpoint and HTTP errors omit secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gmail-queue-refresh-test-"));
  const gmail = new Gmail("unused", join(directory, "token.json"));
  gmail.client = {client_id: "synthetic-client", client_secret: "synthetic-secret"};
  gmail.token = {refresh_token: "synthetic-refresh", expires_at: 0};
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (raw, options) => {
    assert.equal(String(raw), "https://oauth2.googleapis.com/token");
    assert.equal(options.body.get("grant_type"), "refresh_token");
    assert.equal(options.body.get("refresh_token"), "synthetic-refresh");
    return new Response(JSON.stringify({access_token: "refreshed-synthetic", expires_in: 3600}), {status: 200});
  };
  try {
    assert.equal(await gmail.accessToken(), "refreshed-synthetic");
    assert.equal(gmail.token.refresh_token, "synthetic-refresh");
    globalThis.fetch = async () => new Response("secret-code secret-token", {status: 401});
    await assert.rejects(jsonRequest("https://example.test"), error => error.message.includes("401") && !error.message.includes("secret"));
  } finally {globalThis.fetch = originalFetch;}
});
