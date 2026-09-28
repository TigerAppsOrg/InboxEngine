FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY assets ./assets
USER node
EXPOSE 8300
CMD ["node", "--import", "tsx", "src/server/main.ts"]
