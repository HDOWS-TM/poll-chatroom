# 零第三方依赖：不需要 npm install， COPY 完直接跑
FROM node:20-alpine

WORKDIR /app

COPY package.json server.js ./
COPY public ./public

# 消息存档目录（配合 volume 持久化）
RUN mkdir -p /app/data

ENV PORT=3000 \
    NODE_ENV=production

EXPOSE 3000
VOLUME ["/app/data"]

# node:20-alpine 自带 node，用内置 http 模块发健康检查，无需 curl/wget
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+process.env.PORT+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
