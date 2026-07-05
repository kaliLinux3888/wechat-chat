#!/bin/bash
# 微信聊天服务器进程守护脚本
# 用法: ./keepalive.sh [项目目录]

PROJECT_DIR="${1:-$(dirname "$0")}"
LOG_FILE="$PROJECT_DIR/server.log"
PID_FILE="$PROJECT_DIR/server.pid"
HEALTH_INTERVAL=5

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

cd "$PROJECT_DIR" || exit 1

while true; do
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE" 2>/dev/null)
    if ps -p "$PID" > /dev/null 2>&1; then
      # 健康检查：进程在但还要确认 HTTP 通
      if ! curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ | grep -q "200"; then
        log "HTTP 检查失败，重启服务 (PID: $PID)"
        kill "$PID" 2>/dev/null || true
        sleep 1
      else
        sleep "$HEALTH_INTERVAL"
        continue
      fi
    fi
  fi

  # 启动服务
  NODE_OPTIONS="" nohup node server.js >> "$LOG_FILE" 2>&1 &
  NEW_PID=$!
  echo "$NEW_PID" > "$PID_FILE"
  log "启动服务 PID: $NEW_PID"

  # 等待启动
  for i in {1..10}; do
    if curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ | grep -q "200"; then
      log "服务已就绪"
      break
    fi
    sleep 1
  done
done
