FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/domain/package.json packages/domain/
COPY apps/admin-web/package.json apps/admin-web/
COPY apps/field-mobile/package.json apps/field-mobile/
RUN pnpm install --frozen-lockfile
COPY packages/contracts/ packages/contracts/
COPY packages/domain/ packages/domain/
COPY apps/admin-web/ apps/admin-web/
COPY apps/field-mobile/ apps/field-mobile/
COPY docs/design/gemba-tokens.css docs/design/gemba-tokens.css
ENV VITE_API_BASE_URL=/api/v1
RUN pnpm --filter @audit5s/contracts build \
 && pnpm --filter @audit5s/domain build \
 && pnpm --filter @audit5s/admin-web build
# The field app in a browser, for phones without the APK (iOS): served at /field, same origin
# as the API, so it calls `/api/v1` as the admin web does.
RUN cd apps/field-mobile && WEB_BASE_URL=/field API_BASE_URL=/api/v1 npx expo export --platform web --output-dir dist-web

FROM caddy:2-alpine
COPY infra/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/admin-web/dist /srv
COPY --from=build /repo/apps/field-mobile/dist-web /srv/field
