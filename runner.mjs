import {resolve, dirname, basename} from "node:path";
import {fileURLToPath} from "node:url";
import {acquireLock, ageOn, newProfile, readJSON, runSerial, saveJSON} from "./core.mjs";
import {appendGenerated, reconcileQueue, readQueue} from "./queue-files.mjs";
import {queueStatus, printQueueStatus, planRetry} from "./retry.mjs";
import {Gmail, jsonRequest} from "./gmail.mjs";
import {CodeReader} from "./code-reader.mjs";
import {resolveCodeFailure} from "./failure-choice.mjs";
import {launchBrowser, newAccountPage} from "./browser.mjs";
import {driveAccount, summarizeRun, printSummary} from "./account-flow.mjs";
import {profileForAccount, readBrowserMode, saveBrowserMode} from "./browser-mode.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const local = resolve(root, ".local");
let stopping = false;
const stopController = new AbortController();
process.once("SIGINT", () => {stopping = true; stopController.abort(); console.log("\n正在停止当前任务，不会启动下一个账号…");});

function validateStart(start) {
  const url = new URL(start.authorize_url);
  if (url.origin !== "https://auth.openai.com" || url.pathname !== "/api/accounts/authorize" || url.searchParams.get("client_id") !== "app_2SKx67EdpoN0G6j64rFvigXD" || url.searchParams.get("redirect_uri") !== "https://platform.openai.com/auth/callback" || !url.searchParams.get("state")?.startsWith("chatgpt2api-")) throw new Error("服务端尚未运行本对话的 Platform 回调补丁，或授权参数不匹配。请先更新 WSL 容器。");
  return url.searchParams.get("state");
}

async function main() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 24 || (major === 24 && minor < 5)) throw new Error("请使用 Node.js 24.5 或更高版本。");
  const unlock = await acquireLock(resolve(local, "queue.lock"));
  let browser;
  try {
    if (process.argv.includes("--set-browser-mode")) {
      const mode = process.argv[process.argv.indexOf("--set-browser-mode") + 1];
      await saveBrowserMode(local, mode);
      console.log("已设置浏览器模式：" + (mode === "normal" ? "普通窗口（按邮箱保存登录状态）" : "无痕窗口（账号结束后销毁会话）") + "。下次选择 3 或 4 时生效。");
      return;
    }
    const statusFile = resolve(local, "status.json");
    const state = await readJSON(statusFile, {});
    if (process.argv.some(arg => ["--queue-status", "--retry", "--retry-all-safe"].includes(arg))) {
      const queue = await readQueue(root);
      if (process.argv.includes("--queue-status")) {
        const view = queueStatus(queue.emails, state, queue.completed);
        if (process.argv.includes("--json")) console.log(JSON.stringify(view));
        else printQueueStatus(view);
        return;
      }
      const result = planRetry(queue.emails, state, {email: process.argv[process.argv.indexOf("--retry") + 1], allSafe: process.argv.includes("--retry-all-safe"), confirmedNotImported: process.argv.includes("--confirm-not-imported")}, queue.completed);
      if (result.changed.length) await saveJSON(statusFile, result.state);
      console.log(result.changed.length ? `已将 ${result.changed.length} 个账号重新排队；复用已有资料，下次生成新的 OAuth 会话。` : "没有需要变更的账号；待处理账号可直接运行 3 或 4。");
      if (result.review_count && process.argv.includes("--retry-all-safe")) console.log(`另有 ${result.review_count} 个账号需要先核对后端账号池，本次未变更。`);
      console.log("这里只修改排队状态，不立即注册。回到菜单选择 3 或 4 开始。");
      return;
    }
    const credentialsFile = resolve(local, "account-credentials.json");
    const profiles = await readJSON(credentialsFile, {});
    if (process.argv.includes("--generate")) {
      const count = process.argv[process.argv.indexOf("--generate") + 1];
      const domainIndex = process.argv.indexOf("--domain");
      const domain = domainIndex < 0 ? "" : process.argv[domainIndex + 1];
      const result = await appendGenerated(root, count, domain, state, profiles);
      console.log(`已生成 ${result.emails.length} 个不重复邮箱，追加到 ${basename(result.queueFile)}。`);
      console.log("仅生成待处理地址；域名需能收信。可继续选择 2 预览，或选择 3 / 4 开始处理。");
      return;
    }
    const config = await readJSON(resolve(root, "config.json"));
    const clientFile = resolve(root, config.google_client_file || "credentials.json");
    const gmail = new Gmail(clientFile, resolve(local, "gmail-token.json"), config.sender_domains || ["openai.com"]);
    if (process.argv.includes("--gmail-login")) {
      const profile = await gmail.initialize();
      console.log("Gmail 只读连接成功：" + profile.emailAddress);
      return;
    }
    const queue = await reconcileQueue(root, state);
    if (queue.archived) console.log(`已将旧记录中成功导入的 ${queue.archived} 个队列条目移到 accounts-completed.txt。`);
    const emails = queue.emails;
    if (!emails.length) {
      console.log("没有待处理邮箱。可选择菜单 6 生成，或在 accounts.txt 中每行填写一个邮箱。");
      return;
    }
    if (process.argv.includes("--run")) {
      const view = queueStatus(emails, state, queue.completed);
      if (!view.pending_count) {printQueueStatus(view); return;}
    }
    for (const email of emails) if (!profiles[email]) profiles[email] = newProfile();
    await saveJSON(credentialsFile, profiles);
    if (process.argv.includes("--plan")) {
      for (const email of emails) console.log(`${email} | ${profiles[email].name} | ${ageOn(profiles[email].birth_date)} 岁 | ${state[email]?.status || "pending"}`);
      console.log("仅生成并预览本地队列；未访问 Gmail 或注册页面。");
      return;
    }
    if (!process.argv.includes("--run")) throw new Error("请选择 --plan、--gmail-login、--run、--retry 邮箱或 --generate 数量 --domain 域名。");
    const key = process.env.CHATGPT2API_ADMIN_KEY;
    if (!key) throw new Error("请通过 start.ps1 Queue 输入项目管理员密钥，或设置 CHATGPT2API_ADMIN_KEY 环境变量。");
    const base = new URL(config.api_base_url || "http://127.0.0.1:3000");
    if (!["http:", "https:"].includes(base.protocol) || (base.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) || base.username || base.password || base.search || base.hash || base.pathname !== "/") throw new Error("api_base_url 必须是本机 HTTP 地址或你的 HTTPS 服务根地址。");
    const api = (path, body, timeout = 30000) => jsonRequest(new URL(path, base), {method: "POST", headers: {"content-type": "application/json", authorization: "Bearer " + key}, body: JSON.stringify(body), timeout});
    const automatic = !process.argv.includes("--manual-codes");
    const reader = new CodeReader(gmail, {manual: !automatic, failurePolicy: automatic ? "skip" : "dialog", waitSeconds: config.auto_code_wait_seconds ?? 60});
    const gmailProfile = await reader.connect();
    if (gmailProfile) console.log("接码 Gmail：" + gmailProfile.emailAddress);
    console.log("并发数固定为 1。注册资料、密码保存于 .local/account-credentials.json。Ctrl+C 停止队列。");
    const modeIndex = process.argv.indexOf("--browser-mode");
    const browserMode = await readBrowserMode(local, modeIndex < 0 ? undefined : process.argv[modeIndex + 1] || "");
    console.log("浏览器模式：" + (browserMode === "normal" ? "普通窗口；每个邮箱使用自己的浏览器资料。" : "无痕窗口；每个账号使用全新会话。"));
    const used = new Set();
    const before = {...state};
    try {
      await runSerial(emails, state, async value => {
        await saveJSON(statusFile, value);
        const archived = await reconcileQueue(root, value);
        if (archived.archived) console.log(`已移入 accounts-completed.txt，并从 accounts.txt 移除：${archived.archived} 个。`);
      }, async email => {
        console.log("开始：" + email);
        // Snapshot before opening an authorization page, so pre-existing messages cannot be used.
        const guard = await reader.begin(email, used, config.sender_domains || ["openai.com"]);
        const initialReason = reader.pendingFailure;
        const initialChoice = await resolveCodeFailure(reader, {email, signal: stopController.signal, skipManual: automatic});
        if (initialChoice === "stop") throw new Error("用户已停止当前任务。");
        if (initialChoice === "skip") {console.log("已跳过：" + email); return {skipped: true, reason: initialReason || "自动取码不可用"};}
        const started = await api("/api/accounts/oauth/start", {email_hint: email});
        let expectedState;
        try {expectedState = validateStart(started);}
        catch (error) {error.fatal = true; throw error;}
        let page;
        let outcome;
        let primaryError;
        const job = {...profiles[email], email, age: ageOn(profiles[email].birth_date)};
        try {
          browser = await launchBrowser(profileForAccount(local, email, browserMode), config.proxy || "", false, browserMode);
          page = await newAccountPage(browser, expectedState);
          await page.navigate(started.authorize_url);
          outcome = await driveAccount({page, job, reader, guard, used, started, automatic, signal: stopController.signal,
            finish: callback => api("/api/accounts/oauth/finish", {session_id: started.session_id, callback}, 180000)});
          return outcome;
        }
        catch (error) {primaryError = error; throw error;}
        finally {
          try {
            if (page) await page.close();
            if (browser) await browser.close();
            browser = undefined;
          } catch (error) {
            error.fatal = true;
            error.outcome = outcome;
            error.submitted = primaryError?.submitted;
            throw error;
          }
        }
      }, () => stopping, {continueOnError: automatic});
    } finally {
      const summary = summarizeRun(emails, before, state);
      printSummary(summary);
      await saveJSON(resolve(local, "last-run-summary.json"), summary);
    }
    console.log(stopping ? "队列已停止。" : "队列处理完成。");
  } finally {
    try {if (browser) await browser.close();}
    finally {await unlock();}
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {console.error("暂停：" + error.message); process.exitCode = 1;});
}
