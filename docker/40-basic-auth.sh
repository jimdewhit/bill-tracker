#!/bin/sh
set -e

if [ -z "$BASIC_AUTH_USER" ] || [ -z "$BASIC_AUTH_PASS" ]; then
  echo "BASIC_AUTH_USER and BASIC_AUTH_PASS must both be set — refusing to start without auth configured." >&2
  exit 1
fi

htpasswd -cb /etc/nginx/.htpasswd "$BASIC_AUTH_USER" "$BASIC_AUTH_PASS"
