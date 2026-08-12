# Standard Next.js production build (non-standalone: next.config.mjs has no
# `output: "standalone"`, so the runner stage keeps node_modules rather than
# relying on that mode's dependency-tracing copy).
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
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.mjs ./next.config.mjs

EXPOSE 3000
CMD ["npm", "start"]
