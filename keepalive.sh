#!/bin/bash
# 微信聊天服务器进程守护 + Cloudflare 隧道
# 用法: ./keepalive.sh [项目目录]

PROJECT_DIR="${1:-$(dirname "$0")}"
LOG_FILE="$PROJECT_DIR/server.log"
PID_FILE="$PROJECT_DIR/server.pid"
TUNNEL_PID_FILE="$PROJECT_DIR/tunnel.pid"
TUNNEL_URL_FILE="$PROJECT_DIR/tunnel.url"
HEALTH_INTERVAL=5
CLOUDFLARED="/tmp/cloudflared"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

cd "$PROJECT_DIR" || exit 1

# 确保 cloudflared 存在
if [ ! -f "$CLOUDFLARED" ]; then
  log "下载 cloudflared..."
  curl -fsSL -o "$CLOUDFLARED" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod +x "$CLOUDFLARED"
fi

# 启动/检查 Node 服务
start_node() {
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE" 2>/dev/null)
    if ps -p "$PID" > /dev/null 2>&1; then
      if curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ | grep -q "200"; then
        return 0  # 已经在运行
      fi
    fi
  fi
  kill $(cat "$PID_FILE" 2>/dev/null) 2>/dev/null || true
  NODE_OPTIONS="" nohup node server.js >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  log "启动 Node 服务 PID: $!"
  for i in {1..10}; do
    if curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ | grep -q "200"; then
      log "Node 服务已就绪"
      return 0
    fi
    sleep 1
  done
  log "WARN: Node 服务启动超时"
  return 1
}

# 启动/检查 Cloudflare 隧道
start_tunnel() {
  # 检查隧道是否还在运行
  if [ -f "$TUNNEL_PID_FILE" ]; then
    TPID=$(cat "$TUNNEL_PID_FILE" 2>/dev/null)
    if ps -p "$TPID" > /dev/null 2>&1; then
      return 0  # 已经在运行
    fi
  fi

  # 隧道进程已死，启动新的（URL 会变化）
  log "启动 Cloudflare 隧道..."
  $CLOUDFLARED --no-autoupdate tunnel --url http://localhost:3000 \
    > "$PROJECT_DIR/tunnel.log" 2>&1 &
  echo $! > "$TUNNEL_PID_FILE"

  # 等待隧道建立，提取 URL
  for i in {1..15}; do
    sleep 1
    TUNNEL_URL=$(grep -oP 'https://[a-z0-9\-]+\.trycloudflare\.com' "$PROJECT_DIR/tunnel.log" 2>/dev/null | head -1)
    if [ -n "$TUNNEL_URL" ]; then
      echo "$TUNNEL_URL" > "$TUNNEL_URL_FILE"
      log "🌐 公网地址: $TUNNEL_URL"
      return 0
    fi
  done
  log "隧道启动超时"
  return 1
}

# 首次启动
log "===== 聊天服务启动 ====="
start_node
start_tunnel

# 主循环：持续监控
while true; do
  start_node
  start_tunnel
  sleep "$HEALTH_INTERVAL"
done
