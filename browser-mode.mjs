import {createHash, randomBytes} from "node:crypto";
import {resolve} from "node:path";
import {normalizeEmail, readJSON, saveJSON} from "./core.mjs";

export function validateBrowserMode(mode) {
  if (!["normal", "incognito"].includes(mode)) throw new Error("浏览器模式必须是 normal（普通）或 incognito（无痕）。");
  return mode;
}

export async function readBrowserMode(local, override) {
  if (override !== undefined) return validateBrowserMode(override);
  const settings = await readJSON(resolve(local, "browser-settings.json"), {});
  return validateBrowserMode(settings.mode ?? "incognito");
}

export async function saveBrowserMode(local, mode) {
  await saveJSON(resolve(local, "browser-settings.json"), {mode: validateBrowserMode(mode)});
}

export function profileForAccount(local, email, mode) {
  validateBrowserMode(mode);
  const key = createHash("sha256").update(normalizeEmail(email)).digest("hex");
  // Normal profiles persist per email; private runs always use a fresh bootstrap profile.
  return resolve(local, "browser-profiles", mode === "normal" ? key : "private-" + randomBytes(12).toString("hex"));
}
