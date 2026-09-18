# ---- build the static app ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Vite bakes these into the JS bundle at build time, so they must be build
# args (available when `npm run build` runs), not container runtime env vars.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY
# Marks this build as the Docker deployment so the app can show its
# Docker-only Downloads tab — never set for the Electron/Capacitor builds.
ENV VITE_DEPLOYMENT_TARGET=docker
RUN npm run build

# ---- serve it, optionally behind Basic Auth ----
FROM nginx:alpine
RUN apk add --no-cache apache2-utils
COPY --from=build /app/dist /usr/share/nginx/html
COPY docker/default.conf /etc/nginx/conf.d/default.conf
# The official nginx image runs every script in /docker-entrypoint.d/ before
# starting nginx — generating .htpasswd here (from runtime env vars) rather
# than at build time means credentials never end up baked into the image,
# and the same image can be reused with different credentials per deployment.
# Also wires AUTH_MODE (basic|none) into the nginx config — see the script.
COPY docker/40-configure-auth.sh /docker-entrypoint.d/40-configure-auth.sh
RUN chmod +x /docker-entrypoint.d/40-configure-auth.sh
EXPOSE 80
