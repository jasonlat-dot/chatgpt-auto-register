import {randomBytes, randomInt} from "node:crypto";
import {readFile, writeFile, rename, mkdir, open, unlink} from "node:fs/promises";
import {dirname} from "node:path";

export const sleep = ms => new Promise(ok => setTimeout(ok, ms));
export const normalizeEmail = value => String(value).trim().toLowerCase();
export function emailList(text) {
  const values = [...new Set(text.replace(/^\uFEFF/, "").split(/\r?\n/).map(normalizeEmail).filter(x => x && !x.startsWith("#")))];
  for (const value of values) if (!/^[^\s@]+@[^\s@]+[.][^\s@]+$/.test(value) || /[.]example$/.test(value)) throw new Error("请在 accounts.txt 中填写真实的自有邮箱，每行一个。");
  if (!values.length) throw new Error("accounts.txt 中没有账号。");
  return values;
}
export async function readJSON(path, fallback) {
  try {return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));}
  catch (error) {if (error.code === "ENOENT" && fallback !== undefined) return fallback; throw error;}
}
export async function saveJSON(path, value) {
  await mkdir(dirname(path), {recursive: true});
  const temp = path + ".tmp-" + process.pid;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", {mode: 0o600});
  await rename(temp, path);
}
export async function acquireLock(path) {
  await mkdir(dirname(path), {recursive: true});
  let file;
  try {file = await open(path, "wx", 0o600);}
  catch (error) {if (error.code === "EEXIST") throw new Error("队列已锁定。请先确认其他队列窗口已关闭；若是上次异常退出，按 README 清理 .local/queue.lock。"); throw error;}
  await file.writeFile(String(process.pid));
  await file.close();
  return async () => {await unlink(path);};
}
export function ageOn(birthday, today = new Date()) {
  const [year, month, day] = birthday.split("-").map(Number);
  const now = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  return now.getUTCFullYear() - year - (now.getUTCMonth() + 1 < month || (now.getUTCMonth() + 1 === month && now.getUTCDate() < day) ? 1 : 0);
}
export function newProfile(today = new Date()) {
  const first = ["Alex", "Jordan", "Taylor", "Casey", "Riley", "Avery", "Morgan", "Cameron", "Jamie", "Robin"];
  const last = ["Miller", "Parker", "Reed", "Bennett", "Hayes", "Brooks", "Ellis", "Foster", "Wells", "Gray"];
  const targetAge = randomInt(18, 51);
  let birthDate;
  do {
    const year = today.getFullYear() - targetAge - randomInt(2);
    const month = randomInt(1, 13);
    const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const day = randomInt(1, maxDay + 1);
    birthDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  } while (ageOn(birthDate, today) !== targetAge);
  return {name: first[randomInt(first.length)] + " " + last[randomInt(last.length)], birth_date: birthDate, age_at_creation: targetAge, password: "Aa7!" + randomBytes(18).toString("base64url")};
}
export function validatedCallback(raw, expectedState) {
  const url = new URL(raw);
  if (url.origin !== "https://platform.openai.com" || url.pathname !== "/auth/callback" || url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== expectedState) throw new Error("OAuth 回调来源或 state 不匹配，队列已暂停。");
  if (url.searchParams.getAll("code").length !== 1 || !url.searchParams.get("code")) throw new Error("OAuth 回调未提供有效 code，队列已暂停。");
  return raw;
}
function decodePart(part) {
  if (part.mimeType === "text/plain" || part.mimeType === "text/html") {
    return Buffer.from(part.body?.data || "", "base64url").toString("utf8").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
  }
  return (part.parts || []).map(decodePart).join("\n");
}
export function inspectMessage(message, {email, since, baseline, used, senderDomains = ["openai.com"]}) {
  if (baseline.has(message.id) || used.has(message.id) || Number(message.internalDate) < since) return {reason: "old"};
  const headers = message.payload?.headers || [];
  const from = headers.filter(h => h.name.toLowerCase() === "from").map(h => h.value).join(" ");
  const sender = from.match(/[^\s<>@]+@([a-z0-9.-]+)/i)?.[1]?.toLowerCase();
  if (!sender || !senderDomains.some(domain => sender === domain || sender.endsWith("." + domain))) return {reason: "sender"};
  const sentAt = Date.parse(headers.find(h => h.name.toLowerCase() === "date")?.value || "");
  if (Number.isFinite(sentAt) && sentAt < since - 120000) return {reason: "old-forward"};
  const recipientNames = new Set(["to", "cc", "bcc", "x-original-to", "x-forwarded-to", "x-envelope-to", "envelope-to", "original-recipient", "final-recipient"]);
  const recipients = headers.filter(h => recipientNames.has(h.name.toLowerCase())).flatMap(h => h.value.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+/gi) || []).map(normalizeEmail);
  if (!recipients.includes(normalizeEmail(email))) return {reason: "recipient"};
  const subject = headers.filter(h => h.name.toLowerCase() === "subject").map(h => h.value).join(" ");
  const text = subject + "\n" + decodePart(message.payload || {});
  const codes = [...new Set(text.match(/(?<![0-9])[0-9]{6}(?![0-9])/g) || [])];
  if (codes.length !== 1) return {reason: codes.length ? "ambiguous" : "no-code"};
  return {id: message.id, code: codes[0], date: Number(message.internalDate)};
}
export function chooseCode(messages, guard) {
  const candidates = messages.map(message => inspectMessage(message, guard)).filter(x => x.code);
  // More than one new code can be delayed delivery / resends; don't guess which is current.
  if (candidates.length !== 1) return null;
  return candidates[0];
}
export async function runSerial(emails, state, save, execute, shouldStop = () => false, {continueOnError = false} = {}) {
  for (const email of emails) {
    if (shouldStop()) break;
    const previous = state[email];
    if (["imported", "imported_with_warning", "skipped"].includes(previous?.status)) continue;
    if (previous && previous.status !== "pending") {
      if (continueOnError) continue;
      throw new Error(`${email} 的状态是 ${previous.status}。先核对账号池，再按 README 显式重试。`);
    }
    state[email] = {...previous, status: "in_progress", reason: undefined, updated_at: new Date().toISOString()};
    await save(state);
    let result;
    try {result = await execute(email);}
    catch (error) {
      if (error.outcome) {
        result = error.outcome;
      } else {
        state[email] = {...state[email], status: error.submitted ? "unknown_after_submit" : error.code === "ADMIN_AUTH_REJECTED" ? "pending" : "stopped", reason: String(error.message || "当前账号执行失败").slice(0, 500), updated_at: new Date().toISOString()};
        await save(state);
        if (continueOnError && !error.fatal && !shouldStop()) continue;
        throw error;
      }
      state[email] = {...state[email], status: result.skipped ? "skipped" : result.warning ? "imported_with_warning" : "imported", reason: result.reason, updated_at: new Date().toISOString()};
      await save(state);
      throw error;
    }
    state[email] = {...state[email], status: result.skipped ? "skipped" : result.warning ? "imported_with_warning" : "imported", reason: result.reason, updated_at: new Date().toISOString()};
    await save(state);
  }
}
