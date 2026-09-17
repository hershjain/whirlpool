# syntax=docker/dockerfile:1

# Two stages so the devDependencies that compile TypeScript never reach the
# running image. What ships is dist/, the production deps, and the three
# directories the server reads at runtime.
FROM node:22-slim AS builder

WORKDIR /app

# package files and the schema first: `npm ci` runs @prisma/client's postinstall,
# which needs prisma/schema.prisma to generate the client. Copying them ahead of
# src/ also means a source-only change reuses the cached install layer.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npx prisma generate && npm run build


FROM node:22-slim AS runtime

# Set before `npm ci` so npm itself knows this is a production install, and
# before the server starts because it is the single hinge for the dev-login
# gate, the Secure cookie flag, and the login-code transport guard. Also set as
# a Fly secret - deliberately in both places, so forgetting one is not enough
# to open the gate.
ENV NODE_ENV=production

WORKDIR /app

# `prisma` is a runtime dependency, not a dev one: the Fly release command runs
# `npx prisma migrate deploy` inside this image before the new version takes
# traffic, and the CLI has to be here for that.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Both are read at runtime, and neither is compiled: src/anthropic.ts resolves
# prompts at ../prompts relative to dist/, and src/server.ts serves ../public.
# Leaving either out is a boot crash, not a degraded page.
COPY prompts ./prompts
COPY public ./public

# The `node` user ships with the image. Nothing here writes to disk - the
# database is remote and favicons live in it - so root buys nothing.
USER node

EXPOSE 3000

# Not `npm start`: its prestart hook recompiles, which needs the TypeScript
# compiler that this stage deliberately does not have.
CMD ["node", "dist/server.js"]
