import {randomBytes} from "node:crypto";
import {readFile, writeFile, rename, unlink} from "node:fs/promises";
import {resolve, basename} from "node:path";
import {domainToASCII} from "node:url";
import {emailList, normalizeEmail} from "./core.mjs";

const imported = new Set(["imported", "imported_with_warning"]);

async function readText(path) {
  try {return await readFile(path, "utf8");}
  catch (error) {if (error.code === "ENOENT") return null; throw error;}
}

function parse(text, path) {
  if (!String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).some(line => line.trim() && !line.trim().startsWith("#"))) return [];
  try {return emailList(text);}
  catch {throw new Error(`${basename(path)} 中有无效邮箱，请保留每行一个邮箱，注释以 # 开头。`);}
}

// The queue lock serializes program instances. Also refuse to overwrite an editor's changes.
async function replaceText(path, before, after) {
  if (before === after) return;
  const temp = path + ".tmp-" + process.pid + "-" + randomBytes(6).toString("hex");
  try {
    await writeFile(temp, after, {mode: 0o600, flag: "wx"});
    if (await readText(path) !== before) throw new Error(`${basename(path)} 在处理期间被修改，未覆盖；请重新运行整理队列。`);
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(error => {if (error.code !== "ENOENT") throw error;});
  }
}

function appendLines(text, emails) {
  if (!emails.length) return text;
  const content = text || "";
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  return content + (content && !content.endsWith("\n") ? newline : "") + emails.join(newline) + newline;
}

async function snapshot(root) {
  const files = [];
  for (const name of ["accounts.txt"]) {
    const path = resolve(root, name);
    const text = await readText(path);
    if (text !== null) files.push({path, text, emails: parse(text, path)});
  }
  const completedPath = resolve(root, "accounts-completed.txt");
  const completedText = await readText(completedPath);
  return {files, completedPath, completedText, completed: parse(completedText, completedPath)};
}

export async function readQueue(root) {
  const view = await snapshot(root);
  return {...view, emails: [...new Set(view.files.flatMap(file => file.emails))]};
}

export async function reconcileQueue(root, state) {
  const view = await snapshot(root);
  const completed = new Set(view.completed);
  const newlyCompleted = [];
  for (const [rawEmail, record] of Object.entries(state)) {
    const email = normalizeEmail(rawEmail);
    if (imported.has(record?.status) && !completed.has(email)) {
      parse(email, view.completedPath);
      newlyCompleted.push(email);
      completed.add(email);
    }
  }
  // Archive first. If removing a queue entry fails, the next run safely reconciles it.
  await replaceText(view.completedPath, view.completedText, appendLines(view.completedText, newlyCompleted));
  let removed = 0;
  for (const file of view.files) {
    const remaining = file.text.match(/[^\n]*\n|[^\n]+$/g) || [];
    const after = remaining.filter(line => {
      if (!completed.has(normalizeEmail(line.replace(/^\uFEFF/, "")))) return true;
      removed++;
      return false;
    }).join("");
    await replaceText(file.path, file.text, after);
    file.emails = file.emails.filter(email => !completed.has(email));
    file.text = after;
  }
  return {
    ...view, completed: [...completed],
    emails: [...new Set(view.files.flatMap(file => file.emails))],
    queueFile: view.files[0]?.path || resolve(root, "accounts.txt"),
    archived: removed
  };
}

export function generateEmails(rawCount, rawDomain, excluded, makeLocal = () => "user" + randomBytes(8).toString("hex")) {
  if (!/^[1-9][0-9]*$/.test(String(rawCount)) || !Number.isSafeInteger(Number(rawCount)) || Number(rawCount) > 10000) throw new Error("生成数量必须是 1 到 10000 的整数。");
  const count = Number(rawCount);
  const input = String(rawDomain || "").trim().toLowerCase();
  const domain = domainToASCII(input);
  if (!input || /[\s@/:?#\\]/.test(input) || !domain || domain.length > 253 || !domain.includes(".") || domain.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || domain.endsWith(".example")) throw new Error("请输入有效的自有邮箱域名，例如 jasonlat.cc，不要填写 @、网址或完整邮箱。");
  const used = new Set([...excluded].map(normalizeEmail));
  const result = [];
  for (let attempt = 0; result.length < count && attempt < count * 20 + 100; attempt++) {
    const email = makeLocal() + "@" + domain;
    if (used.has(email)) continue;
    used.add(email);
    result.push(email);
  }
  if (result.length !== count) throw new Error("无法生成足够的不重复邮箱，未写入队列，请重新尝试。");
  return result;
}

export async function appendGenerated(root, count, domain, state, profiles) {
  const view = await reconcileQueue(root, state);
  const emails = generateEmails(count, domain, [...view.emails, ...view.completed, ...Object.keys(state), ...Object.keys(profiles)]);
  const before = view.files.find(file => file.path === view.queueFile)?.text ?? null;
  await replaceText(view.queueFile, before, appendLines(before, emails));
  return {emails, queueFile: view.queueFile};
}
