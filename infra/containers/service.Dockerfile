ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build
ARG SERVICE
WORKDIR /workspace
RUN npm install --global pnpm@11.1.3
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json turbo.json ./
COPY packages ./packages
COPY services ./services
COPY apps/web/package.json ./apps/web/package.json
COPY scripts ./scripts
RUN test -n "$SERVICE" && test -f "services/$SERVICE/package.json"
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter "@visualsprint/$SERVICE..." build
RUN pnpm --filter "@visualsprint/$SERVICE" deploy --legacy --prod /runtime
RUN test -f /runtime/dist/main.mjs && test ! -d /runtime/src && test ! -d /runtime/test

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /runtime ./
USER node
EXPOSE 8080
CMD ["node", "dist/main.mjs"]
