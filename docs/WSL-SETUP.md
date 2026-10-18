# 在 WSL 准备 chatgpt2api 后端

基线为 [chatgpt2api v1.8.0 固定提交](https://github.com/basketikun/chatgpt2api/tree/dc105e51bd486bd75c8ef4f74be4bc4724bdfc33)，完整兼容说明见 [COMPATIBILITY.md](COMPATIBILITY.md)。本教程假设 WSL 内已有可用的 Docker Engine 与 Docker Compose。

## 1. 获取固定源码

以下命令用于全新部署。如果 `~/chatgpt2api` 已有配置或改动，先备份，直接在原目录检查版本，不要用新目录覆盖它。

```bash
git clone https://github.com/basketikun/chatgpt2api.git ~/chatgpt2api
cd ~/chatgpt2api
git checkout dc105e51bd486bd75c8ef4f74be4bc4724bdfc33
```

## 2. 应用本仓库补丁

把本仓库的 `patches/chatgpt2api-v1.8.0/apply-platform-capture.sh` 复制到 WSL 的 `~/chatgpt2api/`，在该目录执行：

```bash
cd ~/chatgpt2api
bash apply-platform-capture.sh
docker compose -f docker-compose.yml -f compose.oauth-local.yml build app
docker compose -f docker-compose.yml -f compose.oauth-local.yml up -d --no-build --force-recreate app
docker compose -f docker-compose.yml -f compose.oauth-local.yml ps
```

安装脚本自带补丁，成功后会创建源码备份，并在缺少时补充 `compose.oauth-local.yml`。它不修改你的 `config.json` 和 `data`。仅构建镜像不会更新正在运行的容器，需要上述 `up` 重建步骤。

上游原版 Compose 是 Windows/WSL 主机端口 `3000` 映射到容器 `80`；Windows 端默认连接 `http://127.0.0.1:3000`。如果已经改为 host 网络和 uvicorn 3000 端口，保留自己的主 Compose 配置，不要重复套用端口映射。

## 3. WSL 原生 Docker 的代理构建示例

镜像仓库连接失败时，需要让 Docker 守护进程或构建器能够访问代理。下面的构建参数主要供 Dockerfile 内下载依赖使用，不保证能解决守护进程拉取基础镜像的网络问题。

如果 WSL 使用 mirrored 网络，且已经确认 WSL 可以连接本机 `127.0.0.1:7890` 代理，可沿用：

```bash
cd ~/chatgpt2api
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
docker build --network=host \
  --build-arg HTTP_PROXY=http://127.0.0.1:7890 \
  --build-arg HTTPS_PROXY=http://127.0.0.1:7890 \
  -t chatgpt2api:oauth-loopback-local .

docker compose -f docker-compose.yml -f compose.oauth-local.yml up -d --no-build --force-recreate app
```

代理端口和网络模式需按自己的机器调整。原生 Linux Docker 不保证自动解析 `host.docker.internal`；容器里的 `127.0.0.1` 也不是所有网络模式下的 Windows 主机地址。

## 4. 检查连接与密钥

在 Windows 浏览器打开 `http://127.0.0.1:3000` 检查服务。自动化使用的是 **chatgpt2api 管理员密钥**，不是 OpenAI API key，也不是 Gmail 凭据。

需要在自己的终端核对当前密钥时，先进入包含 Compose 文件的 WSL 目录，再执行：

```bash
cd ~/chatgpt2api
docker compose -f docker-compose.yml -f compose.oauth-local.yml exec app \
  uv run python -c 'from services.config import config; print(config.auth_key)'
```

该命令会在本机显示密钥，不要把输出提交到仓库或放进公开截图。没有挂载配置、挂载路径变化或重新生成配置时，当前密钥可能与旧值不同。

## 5. 后续操作

```bash
cd ~/chatgpt2api
docker compose -f docker-compose.yml -f compose.oauth-local.yml restart app
docker compose -f docker-compose.yml -f compose.oauth-local.yml logs --tail=100 app
```

没有更改后端源码时无需重新打补丁或重新构建。授权进行中不要重启后端，因为 OAuth 会话在内存中有有效期。Windows 自动化程序本身不运行在 WSL 中。
