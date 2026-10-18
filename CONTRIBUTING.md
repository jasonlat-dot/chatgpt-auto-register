# 开发与验证

使用 Node.js 24.5 或更高版本。项目仅依赖 Node 内置模块，不需要安装运行依赖。

```powershell
npm test
```

自动测试使用合成邮箱、模拟邮件、临时目录与模拟 API，不连接真实 Gmail 或创建真实账号。Windows 浏览器集成验证需要 Edge / Chrome，可分别运行：

```powershell
node validation/browser-fixture.mjs
node validation/browser-fixture.mjs --paced
node validation/browser-storage-check.mjs
node validation/unattended-browser-check.mjs
node validation/birthday-browser-check.mjs
node validation/session-browser-check.mjs
```

这些验证使用本机独立浏览器配置和合成页面。生日验证覆盖：默认当天日期、原生 `date`、`YYYY/MM/DD` 和 `MM/DD/YYYY` 文本框、类似 React Aria 的分段编辑，以及受控值 / 隐藏日期不一致时拒绝提交。

Session 验证在普通和无痕的独立浏览器上下文中完成合成登录、验证码、同源 Session 读取及模拟后端导入；测试标签页的所有请求均本地拦截，不登录真实服务。`test/session-import.test.mjs` 另覆盖错账号、过期、重复导入、提交后结果未知和敏感信息裁剪。

模拟页面验证不能代替真实 OpenAI 页面验证。改动表单适配器时应保留提交前的生日校验，避免把不认识的输入控件当作填写成功。新页面无法识别时，自动模式记录原因并继续队列；不要自动绕过验证或盲目重复兑换 code。

PowerShell 文件需保留 UTF-8 BOM，`start.cmd` 保持 ASCII 与 CRLF。Bash 补丁保持 LF。不要把真实邮箱、凭据、账号状态、浏览器配置、调试日志或原始截图加入测试夹具。
