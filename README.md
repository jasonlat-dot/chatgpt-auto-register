# chatgpt-auto-register

Windows 浏览器辅助工具，配合 [basketikun/chatgpt2api](https://github.com/basketikun/chatgpt2api) 使用：串行处理自有域名邮箱，通过 Gmail 只读 API 获取验证码，填写资料，拦截 OAuth 回调并交给后端导入。

**兼容基线：chatgpt2api v1.8.0，提交 [`dc105e51bd486bd75c8ef4f74be4bc4724bdfc33`](https://github.com/basketikun/chatgpt2api/tree/dc105e51bd486bd75c8ef4f74be4bc4724bdfc33)，加本仓库附带的 Platform OAuth 回调补丁。** 未验证的上游新版本或直接使用 `latest` 镜像不保证兼容，详见 [版本说明](docs/COMPATIBILITY.md)。

本项目源码仓库：[jasonlat-dot/chatgpt-auto-register](https://github.com/jasonlat-dot/chatgpt-auto-register)。

## 功能

- 并发固定为 1，每个账号结束并关闭页面后再处理下一个。
- 自动模式遇到手机 / 人机验证、未知表单、取码失败或超时直接跳过，不弹出人工处理选择。
- 普通和无痕浏览器可切换；普通模式按邮箱保存独立资料，无痕模式结束后销毁会话。
- 本地生成姓名、18–50 岁范围内的有效生日和随机密码，重试复用同一资料。
- 生日填写支持原生日期、可识别文本日期和年 / 月 / 日分段控件；覆盖默认当天值，并在提交前检查可见值及可识别的隐藏日期。无法确认时跳过，避免提交当天日期。
- 成功导入后从 `accounts.txt` 移到 `accounts-completed.txt`；跳过和失败的保留。
- 输入数量和域名生成待处理地址，检查待处理、已完成及本地历史数据避免重复。
- 结束时汇总结果，保存 `.local/last-run-summary.json`；兑换结果未知的账号不自动重试。

浏览器页面会变化。本项目有模拟邮件、合成页面和真实 Edge 驱动测试，不能把模拟通过等同于真实服务端注册成功。建议先用一个自有邮箱验证实际页面和转发格式。程序不解决手机验证或人机验证，也不调用 GPT 来理解页面。

## 准备环境

| 组件 | 要求 |
| --- | --- |
| Windows | 可运行 PowerShell，已安装 Edge 或 Chrome |
| Node.js | [Node.js 24.5+](https://nodejs.org/en/download)；没有第三方运行依赖，无须 `npm install` |
| 后端 | WSL / 其他主机运行上述版本及补丁的 chatgpt2api |
| 邮件 | 自有域名邮箱转发到一个 Gmail；自动模式完成 Gmail API 授权 |

需要新部署后端时先看 [WSL 部署教程](docs/WSL-SETUP.md)。已经运行本补丁版后端的用户不必重复构建镜像。

## 快速开始

在 Windows 的固定用户目录中操作，不需要把自动化程序放到 WSL。

```powershell
git clone https://github.com/jasonlat-dot/chatgpt-auto-register.git
cd chatgpt-auto-register
Copy-Item config.example.json config.json
Copy-Item accounts.example.txt accounts.txt
```

编辑本地 `config.json`，确认 `api_base_url` 指向后端。默认示例为 `http://127.0.0.1:3000`，`proxy` 默认留空；需要代理可填 `http://127.0.0.1:7890`，按自己的端口调整。此配置与 WSL 后端的同名文件是两份独立配置。

按照 [域名邮箱教程](docs/DOMAIN-EMAIL.md) 准备收信及转发，再按照 [Gmail API 教程](GMAIL-SETUP.md) 启用 API、创建个人桌面应用凭据并保存为 `credentials.json`。

双击 `start.cmd`，输入数字并按回车：

| 选项 | 用途 |
| --- | --- |
| 1 | 连接 Gmail / 首次只读授权 |
| 2 | 预览本地队列、姓名、年龄和状态，不注册 |
| 3 | 全自动运行，需要人工处理则跳过，最后汇总 |
| 4 | 主动手动接码；验证码直接填在浏览器页面 |
| 5 | 清理失效队列锁；进程仍在运行时不会删除 |
| 6 | 输入数量与自有域名，追加不重复邮箱到队列 |
| 7 | 选择普通 / 无痕浏览器，并保存选择 |
| 8 | 查看异常账号与原因，单个或批量重新排队 |
| 0 | 退出 |

这些是独立功能，不是每次都按 1–8 顺序执行。第一次可先用 **1** 授权，再用 **6** 生成一个地址、**2** 预览、**3** 运行；以后授权有效时可直接用 3。每项结束后回到同一个菜单。程序优先读取本地配置中的 **chatgpt2api 管理员密钥**；缺失或认证不通过时才提示输入。它不是 OpenAI API key 或 Gmail 密码。

`accounts.txt` 每行一个真实的自有邮箱；空行和以 `#` 开头的注释会忽略。示例中的 `.example` 地址需要替换。菜单 6 只生成地址，不能自动购买域名或建立真实邮箱，域名必须已有收信 / catch-all 配置。

自动化打开的是脚本专用浏览器，**不需要在其中打开 chatgpt2api 网页，也不需要安装回调扩展**。程序直接调用后端 API。

## 保存后端管理员密钥

本地 `config.json` 新增字段：

```json
"chatgpt2api_admin_key": ""
```

可以自己填写，也可留空，在选择 3 / 4 时通过隐藏输入框提供。程序先读取此字段，未填写时兼容 `CHATGPT2API_ADMIN_KEY` 环境变量；仍缺失或认证失败时要求重新输入。**新输入仅在管理员认证成功后保存到本机 `config.json`**，保留其他配置项，错误输入不覆盖旧配置。空输入取消并返回菜单。

认证使用后端的 `/auth/login` 并确认 `admin` 角色，不会把 Gmail 授权失败当成后端密钥失败。网络超时或服务端异常会单独报错，不会反复询问密钥。全部账号都是历史未重试状态时，仍先显示队列说明，不索要密钥、不连接 Gmail。

保存的密钥是本地明文配置，应保留在自己的电脑上；`config.json` 已被 Git 忽略，公开仓库只提供密钥为空的 `config.example.json`。程序不在终端、日志或运行摘要中输出密钥。

## 自动模式与结果

选项 3 遇到需要人工处理的步骤会关闭当前账号页面并继续下一账号。未知页面有约 3 秒渲染缓冲，连续无进展约 45 秒跳过；邮件等待默认 60 秒，可用 `auto_code_wait_seconds` 调整。

自动模式不会启动首次 Google 授权；Gmail 未配置或已失效会记录跳过。此时先选择 1 重新连接。旧配置中的 `manual_codes` 不再控制运行模式；需要手动时明确选择 4。

| 文件 | 内容 |
| --- | --- |
| `accounts.txt` | 待处理邮箱；跳过 / 失败的仍在这里 |
| `accounts-completed.txt` | 已确认成功导入的邮箱 |
| `.local/status.json` | 账号状态与异常原因；避免重复兑换 |
| `.local/last-run-summary.json` | 最近一次运行的结果和数量 |
| `.local/account-credentials.json` | 本机生成的姓名、生日和明文密码 |
| `.local/gmail-token.json` | Gmail 授权 token |
| `.local/browser-settings.json` | 普通 / 无痕模式选择 |
| `.local/browser-profiles/` | 脚本的独立浏览器资料 |

成功和已入库但刷新有警告的邮箱都会归档。跳过、失败、进行中和兑换结果未知的历史记录不会自动重试；文件仍在并不代表下一次会盲目重新执行。核对后端账号池后，可显式重新排队：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 Retry -Email "你要重试的邮箱@自己的域名"
```

也可以直接使用菜单 **8**：列表显示邮箱、中文状态、原因与下一步；输入序号重新排队单个账号，输入 **A** 批量重新排队“已停止 / 失败 / 跳过”。结果待核对和上次处理中断的账号不会加入批量重试，须先检查后端账号池，确认未入库后在单个重试时明确确认。已成功导入或位于已完成文件中的账号不能重新排队。

重新排队只改状态，不立即开始注册；保留原资料，并记录上次状态和原因。如果全部账号都是历史未重试状态，选择 3 / 4 会先显示原因及菜单 8 的处理方式，不再索要管理员密钥或连接 Gmail。菜单 5 只清理运行锁，不能重置账号状态。

命令行重试 `unknown_after_submit` 或 `in_progress` 时也必须先核对账号池。确认未入库后，上面的 PowerShell 命令额外加 `-ConfirmedNotImported`；直接使用 `node runner.mjs --retry` 时额外加 `--confirm-not-imported`。其他停止或跳过状态可沿用上面的命令。

然后重新选择 3 或 4。会生成新的 OAuth 会话，复用本机资料，不重复提交旧 code。`Ctrl+C` 请求停止；整体配置错误、写盘失败或浏览器无法关闭时会停止队列并输出已完成部分的摘要。

普通浏览器按邮箱隔离，不复用你平时的浏览器资料。关闭时等待写盘，可能需要几秒；无痕模式不删除之前普通模式的资料，也不删除 Gmail 授权或队列状态。

## 更新与本地数据

提交和公开仓库只包含源码、示例配置、教程、测试以及固定版本补丁。[SECURITY.md](SECURITY.md) 说明忽略规则与本地数据范围。不要提交 `config.json`、`credentials.json`、真实邮箱列表、`.local`、日志或原始截图。

以后更新先退出队列，再在此目录运行 `git pull --ff-only`。本地配置和运行数据被 Git 忽略，不随正常源码更新覆盖；备份时也应把这些私有数据单独保存，不要为了备份加入 Git。

## 常见问题

- **生日仍是当天**：确认正在运行新版 `browser.mjs` 和 `birthday.mjs`。不支持的日期结构会跳过；提供脱敏控件 HTML 或截图供适配，勿提交验证码 / Cookie。
- **Gmail 403 access_denied**：检查当前 Google 项目的测试用户名单；添加的是接收邮件并实际登录授权的 Gmail。
- **此应用未经 Google 验证**：仅在确认是自己创建的客户端时，按 Google 页面提示继续自己的测试授权。详细步骤见 Gmail 教程。
- **连接后端失败**：确认服务运行、端口可达、`api_base_url` 正确。Windows 程序的代理与 WSL 后端的出站代理分别配置。
- **历史记录未重试**：用菜单 8 查看状态和原因；修复原因后重新排队，再运行 3 / 4。已停止、失败和自动跳过都采用这个流程，结果待核对的先检查账号池。
- **队列锁未释放**：确认旧程序退出后用菜单 5；不要删除整个 `.local`。
- **code 已使用 / 兑换结果未知**：先检查账号池，再显式重试；不要再次提交旧回调。

## 开发与许可

```powershell
npm test
```

更多合成页面测试见 [CONTRIBUTING.md](CONTRIBUTING.md)，验证记录见 [VALIDATION.txt](VALIDATION.txt)。本项目遵循 [MIT License](LICENSE)，上游派生补丁保留 [chatgpt2api 的 MIT 许可](licenses/chatgpt2api-MIT.txt)。
