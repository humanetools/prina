#!/usr/bin/env bash
# patch purity gate (T8.4; rules revised 2026-08-21 — patch = backward-compatible)
# For patch tag (vX.Y.Z, Z>0) releases, verifies:
#   1. migrations: only NEW migration files whose every statement is additive
#      (CREATE TABLE / CREATE [UNIQUE] INDEX / ALTER TABLE … ADD COLUMN; an added
#      NOT NULL column must carry a DEFAULT). Rewriting/deleting existing migration
#      files, and any other statement kind (DROP/RENAME/ALTER COLUMN/UPDATE …), fail.
#   2. no docker-compose / env template diff
#   3. no new required env (src/env.ts — fails if keys without optional/default increase)
# Fails if there is no immediately preceding patch tag — a patch is only valid on top of the previous version.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="src/env.ts"

TAG="${1:?Usage: patch-purity-gate.sh vX.Y.Z}"

if [[ ! "$TAG" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  echo "[gate] tag format is not vX.Y.Z: $TAG — gate passed (not applicable)"
  exit 0
fi
PATCH="${BASH_REMATCH[3]}"

if [[ "$PATCH" == "0" ]]; then
  echo "[gate] minor/major release ($TAG) — patch gate not applicable"
  exit 0
fi

PREV_TAG="v${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.$((PATCH - 1))"
if ! git rev-parse "$PREV_TAG" >/dev/null 2>&1; then
  echo "::error::previous tag ($PREV_TAG) not found — a patch can only be released on top of the previous version (§3.6)"
  exit 1
fi

echo "[gate] verifying patch purity for $PREV_TAG..$TAG"
CHANGED=$(git diff --name-only "$PREV_TAG" "$TAG")

FAIL=0

# 1. migrations — additive-only (2026-08-21 rule: safe to auto-apply on the patch channel)
if echo "$CHANGED" | grep -q '^drizzle/'; then
  # 1a. existing migration .sql files must never be rewritten or removed
  TOUCHED_SQL=$(git diff --name-only --diff-filter=MDR "$PREV_TAG" "$TAG" -- 'drizzle/*.sql' || true)
  if [[ -n "$TOUCHED_SQL" ]]; then
    echo "::error::patch release rewrites or removes existing migrations — forbidden"
    echo "$TOUCHED_SQL" | sed 's/^/  - /'
    FAIL=1
  fi
  # 1b. new migration files may contain additive statements only
  ADDED_SQL=$(git diff --name-only --diff-filter=A "$PREV_TAG" "$TAG" -- 'drizzle/*.sql' || true)
  for f in $ADDED_SQL; do
    # strip drizzle breakpoints and SQL line comments, then split on ';'
    SQL=$(git show "$TAG:$f" \
      | sed -e 's/--> statement-breakpoint//g' -e 's/--.*$//' \
      | tr '\n' ' ')
    while IFS= read -r stmt; do
      norm=$(echo "$stmt" \
        | tr '[:lower:]' '[:upper:]' \
        | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
        | tr -s ' ')
      [[ -z "$norm" ]] && continue
      if [[ "$norm" =~ ^CREATE\ TABLE ]] || [[ "$norm" =~ ^CREATE\ (UNIQUE\ )?INDEX ]]; then
        continue
      fi
      if [[ "$norm" =~ ^ALTER\ TABLE\ .*\ ADD\ COLUMN ]]; then
        # NOT NULL without a DEFAULT breaks existing rows — not additive
        if [[ "$norm" == *" NOT NULL"* && "$norm" != *" DEFAULT "* ]]; then
          echo "::error::patch migration adds a NOT NULL column without a DEFAULT — not additive ($f)"
          echo "  - $stmt"
          FAIL=1
        fi
        continue
      fi
      echo "::error::patch migration contains a non-additive statement — forbidden ($f)"
      echo "  - $stmt"
      FAIL=1
    done < <(echo "$SQL" | tr ';' '\n')
  done
fi

# 2. compose/env template diff
if echo "$CHANGED" | grep -qE '^(docker-compose.*\.yml|\.env\.example)$'; then
  echo "::error::patch release contains compose/env template changes — forbidden (§3.6)"
  echo "$CHANGED" | grep -E '^(docker-compose.*\.yml|\.env\.example)$' | sed 's/^/  - /'
  FAIL=1
fi

# 3. new required env — extract and compare the required key sets from env.ts at both tags
if echo "$CHANGED" | grep -q "^${ENV_FILE}$"; then
  TMP_DIR=$(mktemp -d)
  trap 'rm -rf "$TMP_DIR"' EXIT
  git show "$PREV_TAG:$ENV_FILE" > "$TMP_DIR/env-prev.ts"
  git show "$TAG:$ENV_FILE" > "$TMP_DIR/env-curr.ts"
  PREV_REQ=$(node "$SCRIPT_DIR/env-required-keys.mjs" "$TMP_DIR/env-prev.ts")
  CURR_REQ=$(node "$SCRIPT_DIR/env-required-keys.mjs" "$TMP_DIR/env-curr.ts")
  # comm -13: required keys absent before but present now (newly required or optional->required promotion)
  NEW_REQ=$(comm -13 <(echo "$PREV_REQ") <(echo "$CURR_REQ"))
  if [[ -n "$NEW_REQ" ]]; then
    echo "::error::patch release contains new required env — forbidden (§3.6)"
    echo "$NEW_REQ" | sed 's/^/  - /'
    FAIL=1
  fi
fi

if [[ "$FAIL" == "1" ]]; then
  exit 1
fi
echo "[gate] passed"
