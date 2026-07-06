#!/bin/bash
# 聊天服务器进程守护 + Cloudflare隧道 + Serveo隧道
PROJECT_DIR="${1:-$(dirname "$0")}"
LOG_FILE="$PROJECT_DIR/server.log"
PID_FILE="$PROJECT_DIR/server.pid"
TUNNEL_PID_FILE="$PROJECT_DIR/tunnel.pid"
TUNNEL_URL_FILE="$PROJECT_DIR/tunnel.url"
SERVEO_PID_FILE="$PROJECT_DIR/serveo.pid"
SERVEO_URL_FILE="$PROJECT_DIR/serveo.url"
HEALTH_INTERVAL=5
CLOUDFLARED="/tmp/cloudflared"
SSH_KEY="$HOME/.ssh/serveo_key"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"; }

cd "$PROJECT_DIR" || exit 1

# 确保 cloudflared 存在
if [ ! -f "$CLOUDFLARED" ]; then
  log "下载 cloudflared..."
  curl -fsSL -o "$CLOUDFLARED" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod +x "$CLOUDFLARED"
fi

# 生成 serveo SSH key
if [ ! -f "$SSH_KEY" ]; then
  ssh-keygen -t rsa -b 4096 -f "$SSH_KEY" -N "" -q 2>/dev/null
  log "Serveo SSH 密钥已生成"
fi

start_node() {
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE" 2>/dev/null)
    if ps -p "$PID" > /dev/null 2>&1; then
      if curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ | grep -q "200"; then
        return 0
      fi
    fi
  fi
  kill $(cat "$PID_FILE" 2>/dev/null) 2>/dev/null || true
  NODE_OPTIONS="" nohup node server.js >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  log "Node 服务 PID: $!"
  for i in {1..10}; do
    if curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ | grep -q "200"; then
      log "Node 就绪"
      return 0
    fi
    sleep 1
  done
  log "WARN: Node 启动超时"
  return 1
}

start_tunnel() {
  if [ -f "$TUNNEL_PID_FILE" ]; then
    TPID=$(cat "$TUNNEL_PID_FILE" 2>/dev/null)
    if ps -p "$TPID" > /dev/null 2>&1; then return 0; fi
  fi
  log "启动 Cloudflare 隧道..."
  $CLOUDFLARED --no-autoupdate tunnel --url http://localhost:3000 > "$PROJECT_DIR/tunnel.log" 2>&1 &
  echo $! > "$TUNNEL_PID_FILE"
  for i in {1..15}; do
    sleep 1
    URL=$(grep -oP 'https://[a-z0-9\-]+\.trycloudflare\.com' "$PROJECT_DIR/tunnel.log" 2>/dev/null | head -1)
    if [ -n "$URL" ]; then echo "$URL" > "$TUNNEL_URL_FILE"; log "CF隧道: $URL"; return 0; fi
  done
  log "CF隧道超时"
  return 1
}

start_serveo() {
  if [ -f "$SERVEO_PID_FILE" ]; then
    SPID=$(cat "$SERVEO_PID_FILE" 2>/dev/null)
    if ps -p "$SPID" > /dev/null 2>&1; then return 0; fi
  fi
  log "启动 Serveo 隧道..."
  ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ConnectTimeout=15 \
    -i "$SSH_KEY" -R "80:localhost:3000" serveo.net \
    > "$PROJECT_DIR/serveo.log" 2>&1 &
  echo $! > "$SERVEO_PID_FILE"
  for i in {1..10}; do
    sleep 2
    URL=$(grep -oP 'https://[a-z0-9\-]+\.serveo(?:usercontent)?\.\w+' "$PROJECT_DIR/serveo.log" 2>/dev/null | head -1)
    if [ -n "$URL" ]; then echo "$URL" > "$SERVEO_URL_FILE"; log "Serveo: $URL"; return 0; fi
  done
  log "Serveo超时"
  return 1
}

log "===== 聊天服务启动 ====="
start_node
start_tunnel
start_serveo

while true; do
  start_node
  start_tunnel
  start_serveo
  sleep "$HEALTH_INTERVAL"
done
