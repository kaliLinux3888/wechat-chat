FROM node:22-alpine

WORKDIR /app

# 复制应用文件
COPY package.json server.js keepalive.sh ./
COPY public ./public

# 创建数据目录
RUN mkdir -p /app/data

# 暴露端口
EXPOSE 3000

# 使用守护脚本启动，崩溃/端口异常自动重启
CMD ["sh", "./keepalive.sh", "/app"]
