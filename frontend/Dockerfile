# Next.js standalone build — output: "standalone" in next.config.mjs traces
# only the node_modules actually used at runtime, so the runner stage is ~20 MB
# instead of the full node_modules (~300 MB). This halves Docker layer pressure
# on CI runners and eliminates the "no space left on device" failures.

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Baked in at build time — Next.js inlines NEXT_PUBLIC_* vars into the
# client bundle, so these cannot be runtime-only env vars. Production is
# the safe default: a missing URL or accidentally baked localhost URL fails
# the image build instead of shipping a frontend that calls the developer's
# own computer. Docker Compose explicitly opts into the local target.
ARG APP_DEPLOYMENT_TARGET=production
ARG NEXT_PUBLIC_API_BASE_URL=""
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
# Supabase anon key is safe to bake into the public client bundle by design
# (Row Level Security enforces access, not secrecy of this key) -- never do
# the same for the service_role key.
ARG NEXT_PUBLIC_SUPABASE_URL=""
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=""
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
RUN node -e "const required=['NEXT_PUBLIC_API_BASE_URL','NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_ANON_KEY']; for (const key of required) { if (!process.env[key]) throw new Error(key + ' build argument is required'); } const api=new URL(process.env.NEXT_PUBLIC_API_BASE_URL); if (process.env.APP_DEPLOYMENT_TARGET !== 'local' && ['localhost','127.0.0.1','::1'].includes(api.hostname)) throw new Error('Production frontend cannot use a localhost API URL');"
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# standalone/ contains server.js + only the node_modules it needs (~20 MB).
# static/ and public/ are served by the standalone server directly.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
