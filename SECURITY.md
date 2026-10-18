# 本地数据与公开仓库

本程序在你的电脑上处理 Gmail 邮件、账号资料和登录会话。Gmail 使用邮箱级 `gmail.readonly`，不是只授权一个标签；程序不发送或删除邮件。浏览器会话与随机密码可能以本地文件保存。

`.gitignore` 排除：

| 路径 / 类型 | 原因 |
| --- | --- |
| `.local/` | Gmail token、账号密码、处理状态、运行摘要、浏览器 Cookie / 登录状态 |
| `credentials*.json`、`client_secret*.json` | Google OAuth 客户端下载文件 |
| `config.json`、`config.*.json` | 本地服务、代理或后续可能加入的私有配置；只公开 `config.example.json` |
| `accounts*.txt` | 真实待处理及已完成邮箱；只公开 `accounts.example.txt` |
| `.env*`、token / credentials JSON | 密钥和其他授权数据 |
| 日志、截图目录、HAR、数据库、备份、压缩包 | 可能包含回调 code、邮箱、请求头或历史私有数据 |

忽略文件不会撤回已经提交的内容。发布前应使用 `git status --ignored`、`git diff --cached --stat` 和 `git ls-files` 检查。不要用 `git add -f` 强行加入以上文件。报告问题时只提供已脱敏的表单结构或错误类型，不提供验证码、Cookie、完整 OAuth 回调或客户端密钥。

只在自己控制的 Windows 用户目录和域名邮箱上运行。遇到人工验证时自动模式会跳过，不会自动解决手机验证或人机验证。账号和服务的使用仍由相关服务商规则决定。

本项目未设置第三方遥测。Gmail 请求只发往 Google；OAuth/注册访问 OpenAI；导入请求发往你在 `config.json` 中配置的 chatgpt2api 后端。自动化服务端管理员密钥可保存于本机被 Git 忽略的 `config.json` 的 `chatgpt2api_admin_key` 字段，运行时也会放入子进程环境。用户新输入只有在管理员认证通过后才写入配置；程序不在终端或运行摘要中输出密钥。
