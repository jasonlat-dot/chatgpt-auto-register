import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, readFile, writeFile, mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {appendGenerated, generateEmails, profileEmailPrefix, reconcileQueue} from "../queue-files.mjs";
import {readJSON, runSerial, saveJSON} from "../core.mjs";

const fixture = () => mkdtemp(join(tmpdir(), "chatgpt2api-queue-files-"));
const read = (root, name) => readFile(join(root, name), "utf8");

test("confirmed imports move to completed; failed, skipped and uncertain accounts remain pending", async () => {
  const root = await fixture();
  await writeFile(join(root, "accounts.txt"), "\uFEFF# owned mailboxes\r\nDONE@domain.test\r\nwarning@domain.test\r\nskip@domain.test\r\nfailed@domain.test\r\nunknown@domain.test\r\n\r\n");
  const state = {
    "done@domain.test": {status: "imported"}, "warning@domain.test": {status: "imported_with_warning"},
    "skip@domain.test": {status: "skipped"}, "failed@domain.test": {status: "stopped"},
    "unknown@domain.test": {status: "unknown_after_submit"}
  };
  const first = await reconcileQueue(root, state);
  assert.equal(first.archived, 2);
  assert.deepEqual(first.emails, ["skip@domain.test", "failed@domain.test", "unknown@domain.test"]);
  assert.equal(await read(root, "accounts.txt"), "\uFEFF# owned mailboxes\r\nskip@domain.test\r\nfailed@domain.test\r\nunknown@domain.test\r\n\r\n");
  const completed = await read(root, "accounts-completed.txt");
  assert.equal(completed, "done@domain.test\nwarning@domain.test\n");
  assert.equal((await reconcileQueue(root, state)).archived, 0);
  assert.equal(await read(root, "accounts-completed.txt"), completed);
});

test("archive-first interruption recovers without status history and removes duplicate queue occurrences", async () => {
  const root = await fixture();
  await writeFile(join(root, "accounts.txt"), "one@domain.test\nDONE@domain.test\ndone@domain.test\ntwo@domain.test\n");
  await writeFile(join(root, "accounts-completed.txt"), "# previous completion\r\nDone@domain.test\r\n");
  const result = await reconcileQueue(root, {});
  assert.deepEqual(result.emails, ["one@domain.test", "two@domain.test"]);
  assert.equal(result.archived, 2);
  assert.equal(await read(root, "accounts-completed.txt"), "# previous completion\r\nDone@domain.test\r\n");
});

test("completion write failure never removes pending addresses", async () => {
  const root = await fixture();
  const text = "done@domain.test\n";
  await writeFile(join(root, "accounts.txt"), text);
  await mkdir(join(root, "accounts-completed.txt"));
  await assert.rejects(reconcileQueue(root, {"done@domain.test": {status: "imported"}}));
  assert.equal(await read(root, "accounts.txt"), text);
});

test("serial execution saves success state and archives it before starting the next account", async () => {
  const root = await fixture();
  const state = {};
  const statusFile = join(root, "status.json");
  await writeFile(join(root, "accounts.txt"), "one@domain.test\ntwo@domain.test\n");
  const queue = await reconcileQueue(root, state);
  await runSerial(queue.emails, state, async value => {
    await saveJSON(statusFile, value);
    await reconcileQueue(root, value);
  }, async email => {
    if (email === "two@domain.test") {
      assert.equal((await readJSON(statusFile))["one@domain.test"].status, "imported");
      assert.equal(await read(root, "accounts-completed.txt"), "one@domain.test\n");
      assert.equal(await read(root, "accounts.txt"), "two@domain.test\n");
      return {skipped: true};
    }
    return {};
  });
  assert.equal(await read(root, "accounts.txt"), "two@domain.test\n");
  assert.equal(state["two@domain.test"].status, "skipped");
});

test("generation checks case-insensitive history and retries collisions, including collisions within the batch", () => {
  const locals = ["completed", "pending", "oldprofile", "uncertain", "newone", "newone", "newtwo"];
  const generated = generateEmails(2, "MYDOMAIN.TEST", ["COMPLETED@mydomain.test", "pending@mydomain.test", "oldprofile@mydomain.test", "uncertain@mydomain.test"], () => locals.shift());
  assert.deepEqual(generated, ["newone@mydomain.test", "newtwo@mydomain.test"]);
  assert.throws(() => generateEmails(1, "mydomain.test", ["taken@mydomain.test"], () => "taken"), /未写入/);
});

test("generation appends without erasing the queue or its comments and keeps generated batches unique", async () => {
  const root = await fixture();
  await writeFile(join(root, "accounts.txt"), "# keep this\r\nexisting@domain.test");
  await writeFile(join(root, "accounts-completed.txt"), "done@domain.test\n");
  const state = {"failed@domain.test": {status: "stopped"}};
  const profiles = {"profile@domain.test": {name: "Test"}};
  const first = await appendGenerated(root, 100, "domain.test", state, profiles);
  const second = await appendGenerated(root, 100, "domain.test", state, profiles);
  const all = new Set([...first.emails, ...second.emails]);
  assert.equal(all.size, 200);
  assert.ok([...all].every(email => /^[a-z]+\d{8}@domain\.test$/.test(email)));
  const stored = await readJSON(join(root, ".local/account-credentials.json"));
  for (const email of all) assert.equal(email, profileEmailPrefix(stored[email]) + "@domain.test");
  assert.equal(stored["profile@domain.test"].name, "Test");
  assert.ok((await read(root, "accounts.txt")).startsWith("# keep this\r\nexisting@domain.test\r\n"));
  assert.equal((await reconcileQueue(root, state)).emails.length, 201);
  assert.equal(await read(root, "accounts-completed.txt"), "done@domain.test\n");
});

test("email prefix is the normalized full name and real YYYYMMDD birthday, without random suffixes", () => {
  assert.equal(profileEmailPrefix({name: "Alex Miller", birth_date: "1996-05-17"}), "alexmiller19960517");
  assert.equal(profileEmailPrefix({name: "Éva O'Neil", birth_date: "2000-02-29"}), "evaoneil20000229");
  for (const profile of [{name: "", birth_date: "1996-05-17"}, {name: "Alex", birth_date: "2001-02-29"}, {name: "Alex", birth_date: "2000-13-01"}]) {
    assert.throws(() => profileEmailPrefix(profile), /未写入队列/);
  }
});

test("generation excludes stored profiles and historical mailboxes; saves and reuses the exact chosen profile", async () => {
  const root = await fixture();
  const alex = {name: "Alex Miller", birth_date: "1996-05-17", password: "synthetic-original"};
  const eva = {name: "Eva Reed", birth_date: "1999-02-03", password: "synthetic-saved"};
  const robin = {name: "Robin Gray", birth_date: "1990-12-01", password: "synthetic-final"};
  await saveJSON(join(root, ".local/account-credentials.json"), {"alexmiller19960517@domain.test": alex});
  const profiles = {};
  const candidates = [alex, eva, {...eva, password: "must-not-replace-first-accepted"}, robin];
  const result = await appendGenerated(root, 2, "domain.test", {}, profiles, {makeProfile: () => candidates.shift()});
  assert.deepEqual(result.emails, ["evareed19990203@domain.test", "robingray19901201@domain.test"]);
  const stored = await readJSON(join(root, ".local/account-credentials.json"));
  assert.deepEqual(stored["alexmiller19960517@domain.test"], alex);
  assert.deepEqual(stored[result.emails[0]], eva);
  assert.deepEqual(stored[result.emails[1]], robin);
  assert.deepEqual(profiles[result.emails[0]], eva);
  await reconcileQueue(root, {});
  assert.deepEqual(await readJSON(join(root, ".local/account-credentials.json")), stored);
});

test("failure to save matching profile never appends a new mailbox to the queue", async () => {
  const root = await fixture();
  await writeFile(join(root, "accounts.txt"), "existing@domain.test\n");
  await mkdir(join(root, ".local", "account-credentials.json.tmp-" + process.pid), {recursive: true});
  await assert.rejects(appendGenerated(root, 1, "domain.test", {}, {}));
  assert.equal(await read(root, "accounts.txt"), "existing@domain.test\n");
});

test("empty or missing queue can be generated, and old successful status history is migrated first", async () => {
  const root = await fixture();
  assert.deepEqual((await reconcileQueue(root, {})).emails, []);
  const state = {"old@domain.test": {status: "imported"}};
  const result = await appendGenerated(root, "3", "domain.test", state, {});
  assert.equal(result.emails.length, 3);
  assert.equal(await read(root, "accounts-completed.txt"), "old@domain.test\n");
  assert.equal((await reconcileQueue(root, state)).emails.length, 3);
});

test("invalid counts and domains are rejected without queuing partial output", async () => {
  for (const count of [0, -1, "1.5", "1e2", "", "2x", 10001]) assert.throws(() => generateEmails(count, "domain.test", []), /数量/);
  for (const domain of ["", "https://domain.test", "user@domain.test", "domain.test/path", "localhost", "-bad.test", "bad..test", "domain.test?x", "a b.test", "your-domain.example"]) assert.throws(() => generateEmails(1, domain, []), /域名/);
  const root = await fixture();
  await writeFile(join(root, "accounts.txt"), "one@domain.test\n");
  await assert.rejects(appendGenerated(root, 2, "https://bad.test", {}, {}));
  assert.equal(await read(root, "accounts.txt"), "one@domain.test\n");
});
