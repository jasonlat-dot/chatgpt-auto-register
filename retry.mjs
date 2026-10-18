import {normalizeEmail} from "./core.mjs";

export function statusInfo(status) {
  return ({
    pending: {label: "待处理", retry: "pending", action: "选择 3 或 4 开始处理"},
    stopped: {label: "已停止 / 失败", retry: "safe", action: "先排查停止或失败原因，再用菜单 8 重新排队"},
    skipped: {label: "已跳过", retry: "safe", action: "先处理跳过原因，再用菜单 8 重新排队"},
    in_progress: {label: "上次处理中断", retry: "review", action: "先核对后端账号池；确认未入库后用菜单 8 重新排队"},
    unknown_after_submit: {label: "兑换结果待核对", retry: "review", action: "先核对后端账号池；确认未入库后用菜单 8 重新排队"},
    imported: {label: "已成功导入", retry: "done", action: "已完成，不需要重试"},
    imported_with_warning: {label: "已入库（刷新有警告）", retry: "done", action: "已入库，请检查刷新错误，不重新注册"}
  })[status || "pending"] || {label: "无法识别的历史状态", retry: "blocked", action: "先检查本地状态记录，不自动重试"};
}

export function queueStatus(emails, state, completed = []) {
  const done = new Set(completed.map(normalizeEmail));
  const items = [...new Set(emails.map(normalizeEmail))].map(email => {
    const record = state[email];
    const status = done.has(email) ? "imported" : record?.status || "pending";
    return {email, status, ...statusInfo(status), reason: record?.reason || ""};
  });
  return {
    total: items.length,
    pending_count: items.filter(item => item.retry === "pending").length,
    retryable_count: items.filter(item => item.retry === "safe").length,
    review_count: items.filter(item => item.retry === "review").length,
    held_count: items.filter(item => ["safe", "review", "blocked"].includes(item.retry)).length,
    items
  };
}

export function printQueueStatus(view, notify = console.log) {
  notify(`队列状态：可执行 ${view.pending_count} 个，已停止 / 失败 / 跳过 ${view.retryable_count} 个，需要先核对账号池 ${view.review_count} 个。`);
  for (const item of view.items) {
    notify(`${item.email}：${item.label}${item.reason ? "；原因：" + item.reason : ""}。下一步：${item.action}。`);
  }
  if (view.held_count) notify("账号仍在 accounts.txt 不代表会自动重试；菜单 5 只清理锁，菜单 8 才能重新排队。");
  if (!view.pending_count) notify("本次没有可执行账号，未连接 Gmail，也不会打开浏览器。重新排队后再选择 3 或 4。");
}

export function planRetry(emails, state, {email, allSafe = false, confirmedNotImported = false} = {}, completed = []) {
  const view = queueStatus(emails, state, completed);
  let selected;
  if (allSafe) selected = view.items.filter(item => item.retry === "safe");
  else {
    const target = view.items.find(item => item.email === normalizeEmail(email || ""));
    if (!target) throw new Error("该邮箱不在 accounts.txt 中，请检查待处理列表。");
    if (target.retry === "done") throw new Error("该账号已经导入，未重新加入队列。");
    if (target.retry === "blocked") throw new Error("该账号的历史状态无法识别，请先检查本地记录。");
    if (target.retry === "pending") return {state, changed: [], review_count: view.review_count};
    if (target.retry === "review" && !confirmedNotImported) throw new Error("该账号可能已经入库。先核对后端账号池，确认未入库后用菜单 8 单独重新排队；命令行需加 --confirm-not-imported。");
    selected = [target];
  }
  const next = {...state};
  const time = new Date().toISOString();
  for (const item of selected) next[item.email] = {...state[item.email], status: "pending", reason: undefined, retry_from_status: item.status, retry_from_reason: item.reason, retry_requested_at: time, updated_at: time};
  return {state: next, changed: selected.map(item => item.email), review_count: view.review_count};
}
