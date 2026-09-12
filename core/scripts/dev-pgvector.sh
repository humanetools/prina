#!/usr/bin/env bash
# Local dev only: install pgvector into embedded-postgres (T9.3).
# The embedded build has no headers so compiling is impossible, and its pkglibdir is
# hard-compiled to /usr/local/pg-build/lib, so we drop in pgdg's prebuilt .so and
# rewrite module_pathname in the control file to an absolute path.
# Re-run after pnpm install regenerates node_modules. Prod uses an image that bundles pgvector.
set -euo pipefail

NATIVE=$(dirname "$(find "$(dirname "$0")/../node_modules/.pnpm" -maxdepth 7 -path "*linux-x64*/native/bin/pg_ctl" 2>/dev/null | head -1)")/..
NATIVE=$(cd "$NATIVE" && pwd)
PGMAJOR=17
WORK=$(mktemp -d)

echo "embedded-postgres: $NATIVE"
cd "$WORK"
apt-get download "postgresql-${PGMAJOR}-pgvector"
dpkg -x postgresql-${PGMAJOR}-pgvector*.deb x

cp "x/usr/lib/postgresql/${PGMAJOR}/lib/vector.so" "$NATIVE/lib/"
cp x/usr/share/postgresql/${PGMAJOR}/extension/vector* "$NATIVE/share/postgresql/extension/"
sed -i "s|module_pathname = .*|module_pathname = '$NATIVE/lib/vector'|" \
  "$NATIVE/share/postgresql/extension/vector.control"

rm -rf "$WORK"
echo "OK — CREATE EXTENSION vector now works (no restart needed if a dev DB is already running)"
