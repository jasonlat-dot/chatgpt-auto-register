import {access} from "node:fs/promises";
import {resolve} from "node:path";
import {validateBrowserMode} from "./browser-mode.mjs";

export async function findChrome(env = process.env, exists = access) {
  const roots = [env.ProgramFiles || "C:/Program Files", env["ProgramFiles(x86)"] || "C:/Program Files (x86)", env.LOCALAPPDATA].filter(Boolean);
  for (const root of roots) {
    const executable = resolve(root, "Google/Chrome/Application/chrome.exe");
    try {await exists(executable); return executable;} catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
    }
  }
  throw new Error("没有找到 Google Chrome。请先安装 Chrome；程序不会自动改用 Edge。");
}

export function chromeArguments(profile, {mode = "incognito", proxy = "", headless = false} = {}) {
  validateBrowserMode(mode);
  const args = ["--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-background-mode", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--user-data-dir=" + profile, "--disable-extensions"];
  if (mode === "incognito") args.push("--incognito");
  if (headless) args.push("--headless=new");
  if (proxy) args.push("--proxy-server=" + proxy, "--proxy-bypass-list=localhost;127.0.0.1;[::1]");
  args.push("about:blank");
  return args;
}
