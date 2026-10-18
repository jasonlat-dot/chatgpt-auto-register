// Serialized into the page. Keep this function independent of module globals.
export function birthdayPlan(job, action = "inspect", focusIndex = -1) {
  if (location.hostname !== "auth.openai.com" || document.readyState === "loading") return {kind: "none"};
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(job.birth_date || "");
  if (!match) return {kind: "unsupported", reason: "账号生日格式无效"};
  const [, year, month, day] = match;
  const target = {year: Number(year), month: Number(month), day: Number(day)};
  const valid = new Date(Date.UTC(target.year, target.month - 1, target.day));
  if (valid.getUTCFullYear() !== target.year || valid.getUTCMonth() + 1 !== target.month || valid.getUTCDate() !== target.day) return {kind: "unsupported", reason: "账号生日不是有效日期"};
  const elements = [...document.querySelectorAll('input,select,[role="spinbutton"]')];
  const visible = e => !e.disabled && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
  const describe = e => [e.name, e.id, e.autocomplete, e.placeholder, e.getAttribute("aria-label"), e.getAttribute("data-type"), e.getAttribute("data-part"), ...[...(e.labels || [])].map(x => x.textContent), ...(e.getAttribute("aria-labelledby") || "").split(/\s+/).map(id => document.getElementById(id)?.textContent)].filter(Boolean).join(" ").toLowerCase();
  const birthday = /birth|\bdob\b|bday|生日|出生日期/;
  const inBirthdayPage = birthday.test((document.body?.textContent || "").toLowerCase());
  const partOf = e => {
    const label = describe(e);
    if (e.type === "date" || /yyyy.*mm.*dd|mm.*dd.*yyyy|dd.*mm.*yyyy/i.test(label)) return null;
    if (/(?:^|[^a-z])(?:year|yyyy)(?:$|[^a-z])|年/.test(label)) return "year";
    if (/(?:^|[^a-z])(?:month|mm)(?:$|[^a-z])|月/.test(label)) return "month";
    if (/(?:^|[^a-z])(?:day|dd)(?:$|[^a-z])|日份|日期的日|(?:^|\s)日(?:\s|$)/.test(label)) return "day";
    if (e.getAttribute("role") === "spinbutton" && inBirthdayPage) {
      const max = Number(e.getAttribute("aria-valuemax"));
      if (max === 12) return "month";
      if (max >= 28 && max <= 31) return "day";
      if (max >= 1900) return "year";
    }
    return null;
  };
  if (action === "focus") {
    const element = elements[focusIndex];
    // An emptied segment can temporarily have zero width while the framework rerenders.
    if (!element?.isConnected || !element.isContentEditable || element.getAttribute("role") !== "spinbutton" || !partOf(element)) return {kind: "unsupported"};
    element.focus();
    return {kind: "focused"};
  }
  const fields = [];
  let unsupported = false;
  for (let index = 0; index < elements.length; index++) {
    const e = elements[index];
    if (!visible(e) || e.type === "hidden") continue;
    const label = describe(e);
    const part = partOf(e);
    const isSegment = e.getAttribute("role") === "spinbutton" && e.tagName !== "INPUT";
    if (part && (inBirthdayPage || birthday.test(label) || /bday/.test(e.autocomplete))) {
      if (isSegment && !e.isContentEditable) {unsupported = true; continue;}
      const expected = String(target[part]);
      if (e.tagName === "SELECT") {
        const option = [...e.options].find(x => x.value !== "" && Number(x.value) === target[part]);
        if (!option) {unsupported = true; continue;}
        fields.push({index, part, method: "select", expected: option.value});
      } else fields.push({index, part, method: isSegment ? "keyboard" : "value", expected});
      continue;
    }
    if (isSegment) {if (inBirthdayPage) unsupported = true; continue;}
    if (e.tagName !== "INPUT" || !(e.type === "date" || birthday.test(label))) continue;
    if (e.readOnly) {unsupported = true; continue;}
    let expected;
    if (e.type === "date") expected = job.birth_date;
    else {
      const hint = [e.placeholder, e.getAttribute("data-format"), e.value].filter(Boolean).join(" ");
      const yearFirst = /yyyy([/.-])mm[/.-]dd/i.exec(hint) || /\d{4}([/.-])\d{1,2}[/.-]\d{1,2}/.exec(hint);
      if (yearFirst) expected = [year, month, day].join(yearFirst[1]);
      else if (/dd([/.-])mm[/.-]yyyy/i.test(hint)) expected = [day, month, year].join(hint.match(/dd([/.-])mm/i)[1]);
      else if (/mm([/.-])dd[/.-]yyyy/i.test(hint)) expected = [month, day, year].join(hint.match(/mm([/.-])dd/i)[1]);
      else {unsupported = true; continue;}
    }
    fields.push({index, part: "date", method: "value", expected});
  }
  const segmented = fields.filter(f => f.part !== "date");
  if (segmented.length && (segmented.length !== 3 || new Set(segmented.map(f => f.part)).size !== 3)) unsupported = true;
  if (unsupported) return {kind: "unsupported", reason: "生日控件格式无法安全识别"};
  if (!fields.length) return {kind: "none"};
  if (action === "fill") {
    for (const f of fields.filter(f => f.method !== "keyboard")) {
      const e = elements[f.index];
      const proto = e.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(e, f.expected);
      e.dispatchEvent(new Event("input", {bubbles: true}));
      e.dispatchEvent(new Event("change", {bubbles: true}));
    }
  }
  const matches = fields.every(f => {
    const e = elements[f.index];
    const raw = f.method === "keyboard" ? e.getAttribute("aria-valuenow") || e.textContent.trim() : e.value;
    return f.part === "date" || f.method === "select" ? raw === f.expected : raw.trim() !== "" && Number(raw) === Number(f.expected);
  });
  // React date fields often serialize their state through a hidden input. Never submit a stale hidden date.
  const hidden = elements.filter(e => e.tagName === "INPUT" && e.type === "hidden" && birthday.test(describe(e)) && /^\d{4}-\d{2}-\d{2}/.test(e.value));
  return {kind: "birthday", fields, matches: matches && hidden.every(e => e.value.slice(0, 10) === job.birth_date)};
}

export async function prepareBirthday(browser, sessionId, job) {
  const inspect = (action = "inspect", index = -1) => browser.evaluate(sessionId, "(" + birthdayPlan.toString() + ")(" + JSON.stringify(job) + "," + JSON.stringify(action) + "," + index + ")");
  let plan = await inspect();
  if (plan.kind !== "birthday") return plan;
  if (!plan.matches) {
    await inspect("fill");
    const order = {year: 0, month: 1, day: 2};
    for (const f of plan.fields.filter(f => f.method === "keyboard").sort((a, b) => order[a.part] - order[b.part])) {
      if ((await inspect("focus", f.index)).kind !== "focused") return {kind: "unsupported"};
      const key = async (value, code, virtual, text) => {
        await browser.send("Input.dispatchKeyEvent", {type: "keyDown", key: value, code, windowsVirtualKeyCode: virtual, ...(text ? {text, unmodifiedText: text} : {})}, sessionId);
        await browser.send("Input.dispatchKeyEvent", {type: "keyUp", key: value, code, windowsVirtualKeyCode: virtual}, sessionId);
      };
      // Some segmented controls erase one digit per Backspace and move focus when empty.
      for (let i = 0; i < (f.part === "year" ? 4 : 2); i++) {
        if ((await inspect("focus", f.index)).kind !== "focused") return {kind: "unsupported"};
        await key("Backspace", "Backspace", 8);
      }
      if ((await inspect("focus", f.index)).kind !== "focused") return {kind: "unsupported"};
      for (const digit of f.expected) await key(digit, "Digit" + digit, 48 + Number(digit), digit);
      await key("Tab", "Tab", 9);
    }
    await browser.evaluate(sessionId, "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    plan = await inspect();
  }
  return plan.kind === "birthday" && plan.matches ? plan : {kind: "unsupported", reason: "生日写入后校验未通过，未提交表单"};
}
