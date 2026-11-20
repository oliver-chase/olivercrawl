#!/usr/bin/env bash
# validate.sh: this repo's canonical validation. Run `bash scripts/validate.sh` before every commit.
# Every step below runs and a failing step fails the script, so a red test suite never reads as a pass.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# managed:validate-queue block, kept in step by sync-hooks and bootstrap
# One machine-wide queue for validation runs, taken through the validate-queue helper this machine installs.
# Without the helper the run goes ahead unqueued.
VALIDATE_QUEUE_BIN="$HOME/.local/bin/validate-queue"
if [[ -z "${VALIDATE_QUEUE_SLOT:-}" ]]; then
  if [[ -x "$VALIDATE_QUEUE_BIN" ]]; then
    VALIDATE_QUEUE_SLOT="$("$VALIDATE_QUEUE_BIN" acquire --pid $$ --label "$(basename "${REPO_ROOT:-$PWD}")" || true)"
    export VALIDATE_QUEUE_SLOT="${VALIDATE_QUEUE_SLOT:-none}"
    # A script's own EXIT trap wins: the queue reaps a slot whose process has exited, so nothing leaks.
    [[ -n "$(trap -p EXIT)" ]] || trap '"$VALIDATE_QUEUE_BIN" release "$VALIDATE_QUEUE_SLOT" >/dev/null 2>&1 || true' EXIT
  else
    echo "validate: no validate-queue helper at $VALIDATE_QUEUE_BIN, running unqueued" >&2
  fi
fi

if [[ -x .githooks/pre-commit ]]; then
  echo "=== validate: pre-commit gates ==="
  # The tree scan runs every gate over every tracked file, so validation sees what a commit would not.
  OLIVERCODE_SCAN_TREE=1 bash .githooks/pre-commit
fi

echo "=== validate: structure contract ==="
node scripts/check-structure-contract.mjs

# Repo-local gate the shared hook does not carry: this repo is public, so the strings it must
# never contain live in a gitignored .private-patterns file and are checked against tracked files.
if [[ -f .private-patterns ]]; then
  echo "=== validate: private patterns ==="
  patterns="$(grep -v -e '^[[:space:]]*$' -e '^[[:space:]]*#' .private-patterns || true)"
  if [[ -n "$patterns" ]] && git grep -n -F -f <(printf '%s\n' "$patterns") -- . ':!.private-patterns'; then
    echo "validate: a tracked file contains a string listed in .private-patterns" >&2
    exit 1
  fi
fi

# typecheck, tests, comment budget and the decisions ledger
echo "=== validate: npm run check ==="
npm run check

echo "=== validate: passed ==="
