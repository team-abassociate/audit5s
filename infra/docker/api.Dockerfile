# The one API image. Three entrypoints run from it — api, worker-general, worker-report —
# plus the seed, so there is one domain implementation and one deployment artefact
# (ARCHITECTURE.md PART 13, STACK.md §4).
#
# Built for linux/arm64: the target is an Oracle Ampere A1.

# ---- build ------------------------------------------------------------------
FROM node:22-alpine AS build

RUN corepack enable
WORKDIR /repo

# Manifests first, so a dependency install is cached across source-only changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/domain/package.json packages/domain/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/

RUN pnpm install --frozen-lockfile

COPY packages/ packages/
COPY apps/api/ apps/api/

RUN pnpm --filter @audit5s/contracts build \
 && pnpm --filter @audit5s/domain build \
 && pnpm --filter @audit5s/db build \
 && pnpm --filter @audit5s/api build

# Drops dev dependencies from the tree that gets copied forward.
RUN CI=true pnpm install --frozen-lockfile --prod

# ---- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime

# argon2 is a native module; libstdc++ is what its prebuilt binary links against.
#
# Chromium is Alpine's own build, not Playwright's download. Playwright ships glibc
# binaries and this image is musl, so `playwright install` would produce a browser that
# cannot start — and the failure would appear in `worker-report` at the first render
# rather than at build time. `playwright-core` drives whatever executable it is pointed at,
# which is what `CHROMIUM_EXECUTABLE_PATH` below is for.
#
# It lands in the shared image because STACK.md §4 is one image and three entrypoints. Only
# `worker-report` ever launches it, and a binary nothing executes costs disk, not the RAM
# this box is actually short of.
RUN apk add --no-cache libstdc++ tini chromium font-noto \
 && addgroup -S app && adduser -S app -G app

WORKDIR /repo
ENV NODE_ENV=production \
    CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    # Nothing in this image should ever download a browser at run time.
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY --from=build --chown=app:app /repo/node_modules ./node_modules
COPY --from=build --chown=app:app /repo/packages ./packages
COPY --from=build --chown=app:app /repo/apps/api/dist ./apps/api/dist
COPY --from=build --chown=app:app /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=app:app /repo/apps/api/package.json ./apps/api/package.json

USER app
WORKDIR /repo/apps/api

# tini reaps zombies and forwards signals, so a `docker compose down` is a clean
# shutdown rather than a SIGKILL that abandons an in-flight job.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
