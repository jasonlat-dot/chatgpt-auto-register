import {readJSON, saveJSON} from "./core.mjs";
import {jsonRequest} from "./gmail.mjs";

export const ADMIN_AUTH_EXIT = 23;
export const ADMIN_KEY_MISSING_EXIT = 24;

export function adminAuthError() {
  return Object.assign(new Error("ChatGPT2API 管理员密钥无效、已失效或没有管理员权限，请重新输入。"), {code: "ADMIN_AUTH_REJECTED", fatal: true});
}

export function configuredAdminKey(config, environmentKey, candidateEnvironment = false) {
  const text = value => typeof value === "string" ? value.trim() : "";
  return candidateEnvironment ? text(environmentKey) : text(config.chatgpt2api_admin_key) || text(environmentKey);
}

export function apiBase(config) {
  const base = new URL(config.api_base_url || "http://127.0.0.1:3000");
  if (!["http:", "https:"].includes(base.protocol) || (base.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) || base.username || base.password || base.search || base.hash || base.pathname !== "/") throw new Error("api_base_url 必须是本机 HTTP 地址或你的 HTTPS 服务根地址。");
  return base;
}

export async function verifyAdminKey(base, key, request = jsonRequest) {
  if (!key) throw Object.assign(new Error("本地尚未配置 ChatGPT2API 管理员密钥，请通过 start.cmd 输入。"), {code: "ADMIN_KEY_MISSING"});
  let result;
  try {
    result = await request(new URL("/auth/login", base), {method: "POST", headers: {authorization: "Bearer " + key}, timeout: 15000});
  } catch (error) {
    if ([401, 403].includes(error.status)) throw adminAuthError();
    throw error;
  }
  if (result?.ok === true && result.role !== "admin") throw adminAuthError();
  if (result?.ok !== true || result.role !== "admin") throw new Error("后端认证响应不符合预期，请检查 api_base_url 和后端版本。");
}

export async function saveAdminKey(configPath, key, validatedBase) {
  const current = await readJSON(configPath);
  if (apiBase(current).href !== validatedBase.href) throw new Error("配置中的服务地址在验证期间变化，密钥未保存，请重新运行。");
  await saveJSON(configPath, {...current, chatgpt2api_admin_key: key});
}
