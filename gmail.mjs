import {createServer} from "node:http";
import {createHash, randomBytes, timingSafeEqual} from "node:crypto";
import {spawn} from "node:child_process";
import {readJSON, saveJSON, sleep} from "./core.mjs";

const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export async function jsonRequest(url, options = {}) {
  let response;
  try {response = await fetch(url, {...options, redirect: "error", signal: AbortSignal.timeout(options.timeout || 30000)});}
  catch {throw new Error("网络请求失败或超时；请检查代理和网络连接。");}
  if (!response.ok) throw Object.assign(new Error("接口返回 HTTP " + response.status + "；请检查授权/凭据。未输出含敏感信息的响应内容。"), {status: response.status});
  return response.json();
}
export class Gmail {
  constructor(clientPath, tokenPath, domains = ["openai.com"]) {
    this.clientPath = clientPath;
    this.tokenPath = tokenPath;
    this.domains = domains;
    this.cache = new Map();
  }
  async initialize({allowAuthorize = true} = {}) {
    const settings = await readJSON(this.clientPath);
    this.client = settings.installed;
    if (!this.client?.client_id || !this.client?.client_secret) throw new Error("credentials.json 必须是 Google“桌面应用”客户端文件。请按 GMAIL-SETUP.md 配置。");
    this.token = await readJSON(this.tokenPath, {});
    if (this.token.client_id && this.token.client_id !== this.client.client_id) throw new Error("Google 客户端已更换，请先按 README 重置 Gmail 授权文件。");
    if (!this.token.refresh_token) {
      if (!allowAuthorize) throw new Error("Gmail 尚未授权，请先在菜单 1 完成连接。");
      await this.authorize();
    }
    await this.accessToken();
    return this.api("profile");
  }
  async authorize() {
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    let resolveCode;
    const codePromise = new Promise(ok => {resolveCode = ok;});
    const server = createServer((request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      const returned = Buffer.from(url.searchParams.get("state") || "");
      const expected = Buffer.from(state);
      if (url.pathname !== "/google-callback" || returned.length !== expected.length || !timingSafeEqual(returned, expected)) {
        response.writeHead(400); response.end("Invalid callback"); return;
      }
      if (url.searchParams.get("error")) {response.end("Authorization cancelled"); resolveCode(null); return;}
      const code = url.searchParams.get("code");
      if (!code) {response.writeHead(400); response.end("Missing code"); return;}
      response.writeHead(200, {"content-type": "text/plain; charset=utf-8", "cache-control": "no-store"});
      response.end("Gmail 授权已返回，请回到自动化程序窗口。可以关闭此标签页。");
      resolveCode(code);
    });
    await new Promise((ok, reject) => {server.once("error", reject); server.listen(0, "127.0.0.1", ok);});
    const redirect = `http://127.0.0.1:${server.address().port}/google-callback`;
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({client_id: this.client.client_id, redirect_uri: redirect, response_type: "code", scope: SCOPE, state, code_challenge: challenge, code_challenge_method: "S256", access_type: "offline", prompt: "consent"}).toString();
    console.log("请在打开的系统浏览器中，选择接收转发邮件的 Gmail，完成只读授权。");
    const opener = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url.href], {windowsHide: true, stdio: "ignore"});
    opener.on("error", () => resolveCode(null));
    let timer;
    try {
      const code = await Promise.race([codePromise, new Promise(ok => {timer = setTimeout(() => ok(null), 300000);})]);
      if (!code) throw new Error("Gmail 授权取消或超时，请重新运行 Gmail 配置步骤。");
      const result = await jsonRequest("https://oauth2.googleapis.com/token", {method: "POST", body: new URLSearchParams({client_id: this.client.client_id, client_secret: this.client.client_secret, redirect_uri: redirect, grant_type: "authorization_code", code_verifier: verifier, code})});
      this.token = {...result, client_id: this.client.client_id, expires_at: Date.now() + Number(result.expires_in) * 1000};
      if (!this.token.refresh_token) throw new Error("Google 未返回离线刷新凭据，请重新授权。");
      await saveJSON(this.tokenPath, this.token);
    } finally {
      clearTimeout(timer);
      server.closeAllConnections();
      await new Promise(ok => server.close(ok));
    }
  }
  async accessToken() {
    if (this.token.access_token && this.token.expires_at > Date.now() + 60000) return this.token.access_token;
    const refreshed = await jsonRequest("https://oauth2.googleapis.com/token", {method: "POST", body: new URLSearchParams({client_id: this.client.client_id, client_secret: this.client.client_secret, grant_type: "refresh_token", refresh_token: this.token.refresh_token})});
    this.token = {...this.token, ...refreshed, expires_at: Date.now() + Number(refreshed.expires_in) * 1000};
    await saveJSON(this.tokenPath, this.token);
    return this.token.access_token;
  }
  async api(path, query = {}) {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/" + path);
    url.search = new URLSearchParams(query).toString();
    return jsonRequest(url, {headers: {authorization: "Bearer " + await this.accessToken()}});
  }
  async ids() {
    const found = [];
    let pageToken;
    do {
      const query = {q: "newer_than:1d {" + this.domains.map(x => "from:" + x).join(" ") + "}", maxResults: "100", includeSpamTrash: "true"};
      if (pageToken) query.pageToken = pageToken;
      const result = await this.api("messages", query);
      found.push(...(result.messages || []).map(x => x.id));
      pageToken = result.nextPageToken;
      if (pageToken && found.length >= 2000) throw new Error("匹配邮件过多，暂停读取。请缩小邮件筛选范围后重试。");
    } while (pageToken);
    return found;
  }
  async fresh(guard) {
    const messages = [];
    for (const id of await this.ids()) {
      if (guard.baseline.has(id) || guard.used.has(id)) continue;
      if (!this.cache.has(id)) this.cache.set(id, await this.api("messages/" + encodeURIComponent(id), {format: "full"}));
      messages.push(this.cache.get(id));
      await sleep(30);
    }
    return messages;
  }
}
