#!/usr/bin/env bash
# Assemble the OSS mirror tree (IMPL-ee-boundary / STRATEGY-open-source)
# Usage: build-oss-mirror.sh <core-path> <admin-path> <deploy-path> <output-path>
# Principle: the single definition of the OSS filter = physically removing src/ee and test/ee (+ excluding internal-only assets)
set -euo pipefail
CORE="$1"; ADMIN="$2"; DEPLOY="$3"; OUT="$4"

rm -rf "$OUT"
mkdir -p "$OUT/core" "$OUT/admin" "$OUT/install" "$OUT/.github/workflows"

# core — exclude ee, internal docs, EE workflows, and mirror assets
rsync -a "$CORE/" "$OUT/core/" \
  --exclude node_modules --exclude .git --exclude dist --exclude .admin-src \
  --exclude admin-dist --exclude admin-dist-ee --exclude admin-dist-oss \
  --exclude src/ee --exclude test/ee \
  --exclude docs --exclude mirror --exclude .github \
  --exclude README.md --exclude fly.toml

# admin — exclude ee (README is an internal doc, excluded; the root README covers it)
rsync -a "$ADMIN/" "$OUT/admin/" \
  --exclude node_modules --exclude .git --exclude dist \
  --exclude src/ee --exclude README.md

# Installables — prina-deploy/oss (OSS compose + install.sh)
rsync -a "$DEPLOY/oss/" "$OUT/install/"

# Public root docs + public CI
cp "$CORE"/mirror/{LICENSE,NOTICE,README.md,CONTRIBUTING.md,SECURITY.md,CLA.md} "$OUT/"
cp "$CORE"/mirror/PULL_REQUEST_TEMPLATE.md "$OUT/.github/PULL_REQUEST_TEMPLATE.md"
cp "$CORE"/mirror/ci.yml "$OUT/.github/workflows/ci.yml"

# Safety net: EE trace check — fail if the assembled result contains ee directories or gate code
if [ -d "$OUT/core/src/ee" ] || [ -d "$OUT/admin/src/ee" ]; then
  echo "FATAL: ee directory included in mirror" >&2; exit 1
fi
if grep -rq "EE_LICENSE_REQUIRED" "$OUT/core/src" "$OUT/admin/src" 2>/dev/null; then
  echo "FATAL: EE gate code included in mirror" >&2; exit 1
fi

echo "mirror tree ready: $OUT"
