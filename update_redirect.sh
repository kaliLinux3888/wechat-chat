#!/bin/bash
# 更新 GitHub Pages 重定向页面的隧道地址
PROJECT_DIR="$(dirname "$0")"
cd "$PROJECT_DIR"

# 收集所有可用的隧道 URL
URLS=()
for f in tunnel.url serveo.url lhr.url; do
  if [ -f "$f" ]; then
    u=$(cat "$f" 2>/dev/null | tr -d '[:space:]')
    if [ -n "$u" ]; then URLS+=("$u"); fi
  fi
done

if [ ${#URLS[@]} -eq 0 ]; then exit 0; fi

# 生成 JSON 数组
JSON="["
for u in "${URLS[@]}"; do JSON+="\"$u\","; done
JSON="${JSON%,}]"

# 替换 HTML 中的占位符
sed -i "s|__TUNNEL_URLS__|${JSON}|g" docs/index.html
sed -i "s|const URLS = JSON.parse.*|const URLS = ${JSON};|" docs/index.html 2>/dev/null

git add docs/index.html
git commit -m "更新隧道地址" --allow-empty 2>/dev/null
git push origin main 2>/dev/null
