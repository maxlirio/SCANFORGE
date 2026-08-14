#!/usr/bin/env bash
# Deploy the backend to a free Hugging Face Space (Docker SDK, CPU basic).
#
#   hf auth login            # once - free account, no card needed
#   scripts/deploy_space.sh  [space-name]
#
# The Space builds the app from GitHub, so re-run this (or hit "Factory rebuild"
# in the Space settings) after pushing new commits.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SPACE_NAME=${1:-scanforge}

# The CLI often lands in a per-user bin dir that isn't on PATH.
export PATH="$HOME/Library/Python/3.9/bin:$HOME/.local/bin:$PATH"
command -v hf >/dev/null || { echo "The huggingface CLI is missing: pip install -U huggingface_hub"; exit 1; }
USER_NAME=$(hf auth whoami 2>/dev/null | head -1 | tr -d '\r') || true
if [ -z "${USER_NAME}" ] || [ "${USER_NAME}" = "Not logged in" ]; then
  echo "Not logged in. Run:  hf auth login"
  exit 1
fi
REPO="${USER_NAME}/${SPACE_NAME}"
echo "Deploying to https://huggingface.co/spaces/${REPO}"

hf repo create "${SPACE_NAME}" --repo-type space --space_sdk docker --exist-ok

TMP=$(mktemp -d)
cp "$ROOT/deploy/huggingface/README.md" "$ROOT/deploy/huggingface/Dockerfile" "$TMP/"
hf upload "${REPO}" "$TMP" . --repo-type space --commit-message "Deploy SCANFORGE"
rm -rf "$TMP"

echo ""
echo "Building. It takes a few minutes; watch the logs at:"
echo "  https://huggingface.co/spaces/${REPO}"
echo "Then open that URL on your phone."
