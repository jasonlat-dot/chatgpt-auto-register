import {sleep} from "./core.mjs";
import {resolveCodeFailure} from "./failure-choice.mjs";
import {statusInfo} from "./retry.mjs";

export function manualReason(kind) {
  return ({"manual-verification": "页面要求手机验证或人机验证", "manual-profile": "注册资料表单需要人工填写", "otp-manual": "验证码已被手工填写，需要人工提交", manual: "页面无法自动处理，需要人工操作"})[kind];
}

export async function driveAccount({page, job, reader, guard, used, started, finish, signal, automatic = true, notify = console.log, now = Date.now, pause = sleep}) {
  const deadline = Math.min(guard.since + 540000, now() + (Number(started.expires_in || 600) - 30) * 1000);
  let previousKind;
  let kindSince = now();
  let lastMailCheck = -Infinity;
  let stepErrors = 0;
  let submitted = false;
  const skip = reason => ({skipped: true, reason});
  try {
    while (now() < deadline && !signal?.aborted) {
      if (page.callback) {
        submitted = true;
        const result = await finish(page.callback);
        if (!Number.isInteger(result.added) || !Number.isInteger(result.skipped) || result.added < 0 || result.skipped < 0 || result.added + result.skipped < 1) throw new Error("后端未确认账号已入库，请检查账号池；当前邮箱保留在待处理文件中。");
        return {warning: !!result.errors?.length};
      }
      let step;
      try {step = await page.step(job); stepErrors = 0;}
      catch {
        if (++stepErrors >= 5 && automatic) return skip("连续无法识别或操作当前页面");
        await pause(1000); continue;
      }
      if (step.kind !== previousKind) {
        kindSince = now();
        previousKind = step.kind;
        if (!automatic) {
          const hint = manualReason(step.kind);
          if (hint) notify(hint + "，请在当前浏览器处理。");
          else if (step.kind === "otp") notify("请在浏览器填写验证码并点击继续。");
        }
      }
      const needsManual = manualReason(step.kind);
      // A brief grace period avoids mistaking a redirect or a page still rendering for an unknown form.
      if (automatic && needsManual && (step.kind !== "manual" || now() - kindSince >= 3000)) return skip(needsManual);
      if (automatic && ["waiting", "advanced", "signup", "loading", "otp-waiting"].includes(step.kind) && now() - kindSince >= 45000) return skip("页面长时间没有进展，需要人工检查");
      if (!automatic && step.kind === "otp-manual") reader.useManual("检测到手工输入验证码。");
      const failureReason = reader.pendingFailure;
      const choice = await resolveCodeFailure(reader, {email: job.email, signal, skipManual: automatic});
      if (choice === "stop") throw new Error("用户已停止当前任务。");
      if (choice === "skip") return skip(failureReason || "自动取码不可用");
      if (!["otp", "otp-waiting"].includes(step.kind)) reader.resetWait();
      if (step.kind === "otp" && !reader.manual && now() - lastMailCheck > 3000) {
        lastMailCheck = now();
        const candidate = await reader.read(guard);
        if (candidate) {
          if (page.callback) continue;
          const result = await page.step(job, candidate.code);
          if (result.kind === "otp-submitted") used.add(candidate.id);
          else if (result.kind === "otp-manual") {
            if (automatic) return skip(manualReason("otp-manual"));
            reader.useManual("检测到手工输入验证码。");
          }
        }
        if (automatic && reader.pendingFailure) return skip(reader.pendingFailure);
      }
      await pause(800);
    }
    if (signal?.aborted) throw new Error("用户已停止当前任务。");
    if (automatic) return skip("当前 OAuth 会话即将过期，未自动完成");
    throw new Error("当前 OAuth 会话即将过期，队列已暂停。");
  } catch (error) {error.submitted = submitted; throw error;}
}

export function summarizeRun(emails, before, state) {
  const counts = {success: 0, warning: 0, skipped: 0, failed: 0, unknown: 0, held: 0, unprocessed: 0};
  const items = emails.map(email => {
    const record = state[email];
    const changed = record !== before[email];
    let category;
    if (!changed) category = record && record.status !== "pending" ? "held" : "unprocessed";
    else category = ({imported: "success", imported_with_warning: "warning", skipped: "skipped", stopped: "failed", unknown_after_submit: "unknown"})[record?.status] || "unprocessed";
    counts[category]++;
    return {email, category, status: record?.status || "pending", ...(record?.reason ? {reason: record.reason} : {})};
  });
  return {finished_at: new Date().toISOString(), total: emails.length, counts, items};
}

export function printSummary(summary, notify = console.log) {
  const n = summary.counts;
  notify(`本次完成情况（共 ${summary.total} 个）：成功 ${n.success}，已入库但刷新有警告 ${n.warning}，跳过 ${n.skipped}，失败 ${n.failed}，兑换结果待核对 ${n.unknown}，历史记录未重试 ${n.held}，未处理 ${n.unprocessed}。`);
  for (const item of summary.items) if (["skipped", "failed", "unknown", "held"].includes(item.category)) {
    const info = statusInfo(item.status);
    notify(`${item.email}：${item.reason || info.label}`);
    notify(`  状态：${info.label}；下一步：${info.action}。`);
  }
  if (n.skipped || n.failed || n.held || n.unknown) notify("账号不会因仍在 accounts.txt 就自动重试。菜单 8 可重新排队；菜单 5 仅清理运行锁。");
  notify("详细结果已保存到 .local/last-run-summary.json；跳过和失败的邮箱保留在 accounts.txt。");
}
