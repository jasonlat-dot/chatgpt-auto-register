import {normalizeEmail} from "./core.mjs";
import {driveAccount} from "./account-flow.mjs";

function rejected(reason) {
  return Object.assign(new Error(reason), {outcome: {skipped: true, reason}});
}

export function sessionToken(session, expectedEmail, now = Date.now()) {
  const token = session?.accessToken;
  if (typeof token !== "string" || !token.trim() || token.length > 65536) throw rejected("Session JSON 缺少有效 accessToken，未导入。");
  const email = session?.user?.email;
  if (typeof email !== "string" || normalizeEmail(email) !== normalizeEmail(expectedEmail)) throw rejected("浏览器登录邮箱与当前队列不一致或无法核对，未导入。");
  if (session.expires !== undefined && (!Number.isFinite(Date.parse(session.expires)) || Date.parse(session.expires) <= now)) throw rejected("浏览器 Session 已过期或到期时间无效，请重新登录。");
  const parts = token.split(".");
  if (parts.length === 3) {
    let claims;
    try {claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));}
    catch {throw rejected("Session accessToken 格式无效，未导入。");}
    if (claims.exp !== undefined && (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now)) throw rejected("Session accessToken 已过期或到期时间无效，未导入。");
    for (const claimedEmail of [claims.email, claims["https://api.openai.com/profile"]?.email]) {
      if (claimedEmail !== undefined && (typeof claimedEmail !== "string" || normalizeEmail(claimedEmail) !== normalizeEmail(expectedEmail))) throw rejected("Session Token 邮箱与当前队列不一致，未导入。");
    }
  }
  return token.trim();
}

export async function submitSession(session, expectedEmail, api, now = Date.now()) {
  const token = sessionToken(session, expectedEmail, now);
  let result;
  try {result = await api("/api/accounts", {tokens: [token]}, 180000);}
  catch (error) {
    if (error.code === "ADMIN_AUTH_REJECTED") throw error;
    throw new Error("Session 提交失败或响应异常；结果待核对，请检查后端账号池。未输出响应内容。");
  }
  if (!Array.isArray(result?.items) || !result.items.some(item =>
    normalizeEmail(item.email || "") === normalizeEmail(expectedEmail) || item.access_token === token || item.accessToken === token)) {
    throw new Error("Session 已提交，但后端未确认账号仍在池中；请检查账号池与自动移除设置，未记为成功。");
  }
  // Drop the backend's complete account list and error bodies before returning to the queue.
  return {added: result.added, skipped: result.skipped, errors: result.errors?.length ? [{}] : []};
}

export async function driveSessionAccount(options) {
  const {page, job, api, now = Date.now} = options;
  let lastProbe = -Infinity;
  let failures = 0;
  return driveAccount({...options, started: {expires_in: 600}, flowLabel: "Session 登录", mailFailureOnOtpOnly: true,
    readCompletion: async () => {
      if (now() - lastProbe < 3000) return null;
      lastProbe = now();
      let probe;
      try {probe = await page.readSession();}
      catch {if (++failures >= 3) throw rejected("连续读取浏览器 Session 失败，已跳过当前账号。"); return null;}
      if (["not-on-site", "empty"].includes(probe?.kind)) {failures = 0; return null;}
      if (probe?.kind !== "ready") {
        if (++failures >= 3) throw rejected("浏览器 Session 接口不可用或响应异常，已跳过当前账号。");
        return null;
      }
      failures = 0;
      sessionToken(probe.session, job.email, now());
      return probe.session;
    },
    finish: session => submitSession(session, job.email, api, now())});
}

// Runs only in the script's authenticated ChatGPT tab. Nothing is persisted or logged.
export async function browserSessionProbe() {
  if (location.origin !== "https://chatgpt.com") return {kind: "not-on-site"};
  try {
    const response = await fetch("/api/auth/session", {credentials: "include", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8000)});
    if (response.status === 401) return {kind: "empty"};
    if (!response.ok) return {kind: "unavailable"};
    const text = await response.text();
    if (text.length > 1048576) return {kind: "unavailable"};
    const data = JSON.parse(text);
    if (!data || (typeof data === "object" && !Array.isArray(data) && !data.accessToken && !data.user?.email)) return {kind: "empty"};
    if (typeof data.accessToken !== "string" || !data.accessToken.trim()) return {kind: "unavailable"};
    return {kind: "ready", session: {accessToken: data.accessToken, user: {email: data.user?.email}, ...(data.expires === undefined ? {} : {expires: data.expires})}};
  } catch {return {kind: "unavailable"};}
}

export function sessionLandingStep() {
  if (document.readyState === "loading" || location.href === "about:blank") return {kind: "loading"};
  if (location.origin !== "https://chatgpt.com") return {kind: "manual"};
  const visible = element => !element.disabled && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
  if (/verify you are human|验证您是真人|确认您是真人|电话号码是必填项/i.test((document.body?.innerText || "").slice(0, 10000)) || [...document.querySelectorAll("iframe")].some(x => visible(x) && /captcha|challenge/i.test(x.src))) return {kind: "manual-verification"};
  // ChatGPT can render email/password/OTP directly on its own login route.
  if (/^\/auth\/(?:login|log-in)(?:\/|$)/.test(location.pathname) && [...document.querySelectorAll("input")].some(element =>
    visible(element) && (["email", "password"].includes(element.type) || element.autocomplete === "one-time-code" ||
      /\b(email|otp|code|verification.code)\b|邮箱|电子邮件|验证码/i.test([element.name, element.id, element.placeholder, element.getAttribute("aria-label")].join(" "))))) return {kind: "login-form"};
  const login = [...document.querySelectorAll("button,a")].find(element => visible(element) && /^(log in|login|sign in|登录|登入)$/i.test(element.innerText.trim()));
  if (login && Date.now() - (window.__cg2SessionLoginClick || 0) > 3000) {
    window.__cg2SessionLoginClick = Date.now();
    login.click(); return {kind: "advanced"};
  }
  return {kind: "waiting"};
}
