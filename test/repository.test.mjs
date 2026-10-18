import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFileSync} from "node:child_process";

test("repository ignore rules exclude private data but preserve examples, docs and source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cg2-repository-ignore-"));
  await writeFile(join(dir, ".gitignore"), await readFile(new URL("../.gitignore", import.meta.url)));
  await writeFile(join(dir, "empty-excludes"), "");
  execFileSync("git", ["init", "-q", dir], {stdio: "pipe"});
  const privatePaths = [".local/gmail-token.json", ".local/account-credentials.json", ".local/browser-profiles/abc/Default/Network/Cookies", "accounts.txt", "accounts-completed.txt", "config.json", "config.private.json", "credentials.json", "credentials-copy.json", "client_secret_123.apps.googleusercontent.com.json", ".env", ".env.local", "trace.har", "logs/run.log", "screenshots/error.png", "backup.zip", "accounts.csv"];
  const publicPaths = [".gitignore", ".gitattributes", "config.example.json", "accounts.example.txt", "README.md", "GMAIL-SETUP.md", "birthday.mjs", "test/repository.test.mjs", "docs/COMPATIBILITY.md", "patches/chatgpt2api-v1.8.0/apply-platform-capture.sh", "licenses/chatgpt2api-MIT.txt", "LICENSE"];
  const output = execFileSync("git", ["-C", dir, "-c", "core.excludesFile=" + join(dir, "empty-excludes"), "check-ignore", "--no-index", "--stdin", "-z"], {input: [...privatePaths, ...publicPaths].join("\0") + "\0", encoding: "utf8"});
  const ignored = new Set(output.split("\0").filter(Boolean));
  for (const path of privatePaths) assert.ok(ignored.has(path), path + " must stay private");
  for (const path of publicPaths) assert.ok(!ignored.has(path), path + " must stay publishable");
});
