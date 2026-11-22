FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile
COPY src ./src
RUN pnpm build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY --from=builder /app/dist ./dist

EXPOSE 3000
USER node
CMD ["node", "dist/index.js"]
