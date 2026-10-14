ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /workspace
RUN npm install --global pnpm@11.1.3
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json turbo.json ./
COPY packages ./packages
COPY services ./services
COPY apps/web ./apps/web
ARG VITE_WORKOS_CLIENT_ID
ARG VITE_WORKOS_API_HOSTNAME
ENV VITE_WORKOS_CLIENT_ID=${VITE_WORKOS_CLIENT_ID} VITE_WORKOS_API_HOSTNAME=${VITE_WORKOS_API_HOSTNAME}
RUN test -n "$VITE_WORKOS_CLIENT_ID" && test -n "$VITE_WORKOS_API_HOSTNAME"
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter @visualsprint/web build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /workspace/apps/web/dist ./dist
COPY --chown=node:node infra/containers/web-server.mjs ./web-server.mjs
USER node
EXPOSE 8080
CMD ["node", "web-server.mjs"]
