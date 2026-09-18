#!/bin/sh
set -e

AUTH_MODE="${AUTH_MODE:-basic}"
CONF=/etc/nginx/conf.d/default.conf

case "$AUTH_MODE" in
  basic)
    if [ -z "$BASIC_AUTH_USER" ] || [ -z "$BASIC_AUTH_PASS" ]; then
      echo "AUTH_MODE=basic requires BASIC_AUTH_USER and BASIC_AUTH_PASS — refusing to start without auth configured." >&2
      exit 1
    fi
    htpasswd -cb /etc/nginx/.htpasswd "$BASIC_AUTH_USER" "$BASIC_AUTH_PASS"
    sed -i "/#AUTH_BASIC#/c\\
    auth_basic \"Bill Tracker\";\\
    auth_basic_user_file /etc/nginx/.htpasswd;" "$CONF"
    ;;
  none)
    echo "AUTH_MODE=none — nginx Basic Auth is disabled for this deployment. Make sure sign-in is handled another way (e.g. the app's own Supabase Auth) — without one, this app is reachable by anyone with the URL." >&2
    sed -i "/#AUTH_BASIC#/d" "$CONF"
    ;;
  *)
    echo "Unrecognized AUTH_MODE '$AUTH_MODE' — expected 'basic' or 'none'." >&2
    exit 1
    ;;
esac
