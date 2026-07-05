# 微信风格聊天 · 部署指南

> 项目已改造为「短轮询 + 本地文件持久化 + 进程守护」架构，可长期稳定运行。

## 快速启动（本地 / 沙箱）

```bash
cd /workspace/chat-app
./keepalive.sh
```

服务启动后会自动：
- 拉起 `node server.js`
- 每 5 秒做 HTTP 健康检查
- 进程崩溃或端口不通时自动重启
- 登录、消息自动保存到 `data/` 目录

## 部署到自有服务器（推荐）

1. 把项目上传到服务器
2. 安装 Node.js 22+
3. 运行：

```bash
cd /path/to/chat-app
./keepalive.sh
```

4. 用 Nginx/Caddy 反向代理到 `3000` 端口，即可通过域名访问。

## Docker 部署

```bash
cd /workspace/chat-app
docker build -t wechat-chat .
docker run -d -p 3000:3000 -v $(pwd)/data:/app/data --name wechat-chat wechat-chat
```

## 部署到 Render（免费在线）

1. 把代码 push 到 GitHub
2. 在 [render.com](https://render.com) 创建 **Web Service**
3. Build Command 留空或填 `npm install`
4. Start Command 填 `node server.js`（Render 自带保活）
5. 添加 **Disk**，挂载路径 `/app/data`（用于持久化）
6. 部署后即可获得长期可用公网 URL

## 部署到 Railway

1. Push 到 GitHub
2. 在 [railway.app](https://railway.app) 导入仓库
3. 添加 **Volume**，挂载路径 `/app/data`
4. 部署完成后 Railway 会自动分配域名

## 持久化数据

- `data/users.json`：所有用户信息、头像颜色
- `data/messages.json`：所有聊天记录
- `data/meta.json`：`globalSeq` 和 `messageIdCounter`

服务器重启后自动读取，不丢数据。

## 健康检查

```bash
curl http://<你的域名>/
```

返回 `200` 即服务正常。
