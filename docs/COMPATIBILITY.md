# chatgpt2api 版本与 OAuth 兼容性

本项目是 Windows 浏览器辅助程序，后端使用 [basketikun/chatgpt2api](https://github.com/basketikun/chatgpt2api)，不是独立的 OpenAI API 服务。

| 项目 | 本次适配基线 |
| --- | --- |
| 上游版本 | **v1.8.0** |
| 上游提交 | [`dc105e51bd486bd75c8ef4f74be4bc4724bdfc33`](https://github.com/basketikun/chatgpt2api/tree/dc105e51bd486bd75c8ef4f74be4bc4724bdfc33) |
| 后端要求 | OAuth：上述版本加 **Platform OAuth 回调补丁**；Session JSON：上述版本原有接口 |
| 补丁文件 | [`patches/chatgpt2api-v1.8.0/apply-platform-capture.sh`](../patches/chatgpt2api-v1.8.0/apply-platform-capture.sh) |
| 本地自动化 | Node.js 24.5+，Windows Edge / Chrome，PowerShell |
| 验证日期 | 2026-10-18 |

未经验证的上游新版本不在兼容承诺范围内。`latest` 镜像可能随上游更新，不等同于这里固定的版本。补丁会检查源码哈希：已应用则不重复打补丁，遇到不认识的源码修改会停止。保留备份，不要强行覆盖校验失败的文件。

## OAuth 模式为什么需要补丁

脚本调用后端的 `POST /api/accounts/oauth/start` 和 `POST /api/accounts/oauth/finish`，使用后端的管理员密钥认证。启动响应必须包含 `session_id`、`authorize_url`，授权参数的 `state` 以 `chatgpt2api-` 开头。

此流程保留 Platform 的授权入口 `/api/accounts/authorize`、公开客户端 ID `app_2SKx67EdpoN0G6j64rFvigXD` 和原始回调 `https://platform.openai.com/auth/callback`。自动化浏览器在回调请求发出前通过 CDP 拦截，再交给后端兑换。不是等网页加载后修改地址，也不是复用已经兑换过的 code。

普通和无痕模式的回调拦截都由程序完成，不需要额外安装扩展，也不需要在这个浏览器中打开 chatgpt2api 网页。手动浏览器使用扩展的旧流程是另一种使用方式；本仓库不要求安装它。

## Session JSON 模式

菜单 9 使用浏览器当前登录状态读取 `https://chatgpt.com/api/auth/session`，核对邮箱后将 accessToken 交给后端 `POST /api/accounts`，与原版网页的 Session JSON 导入一致。不调用 OAuth start/finish，不要求回调补丁、浏览器扩展或重新构建后端。认证仍使用 `/auth/login` 验证管理员角色。此模式不获取 refresh_token，不能承诺 OAuth 自动续期。

## 已有后端与新部署

已经运行本补丁版后端的用户，只需更新 Windows 端程序，无需再次构建 Docker 镜像。新部署参考 [WSL 部署教程](WSL-SETUP.md)。

上游源代码与附带补丁中的上游派生代码遵循上游 MIT 许可证，见 [上游许可副本](../licenses/chatgpt2api-MIT.txt)。本仓库代码许可见 [LICENSE](../LICENSE)。

浏览器界面可能由 OpenAI 随时调整。日期填写已覆盖原生日期、可识别格式的文本日期及年/月/日分段控件，并在提交前检查可见值和可识别的隐藏日期状态。真实页面出现新的结构时，自动模式会跳过，不会把无法确认的默认当天日期当作成功填写。
