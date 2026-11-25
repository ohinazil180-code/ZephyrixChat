#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: ./scripts/push-github.sh https://github.com/<username>/<repo>.git"
  exit 1
fi

REMOTE_URL="$1"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git init -b main
fi

git branch -M main

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REMOTE_URL"
else
  git remote add origin "$REMOTE_URL"
fi

git add .
if ! git diff --cached --quiet; then
  git commit -m "Deploy Zephyrix web app"
fi

git push -u origin main

CLEAN_URL="${REMOTE_URL%.git}"
if [[ "$CLEAN_URL" =~ github\.com[:/]([^/]+)/([^/]+)$ ]]; then
  GH_USER="${BASH_REMATCH[1]}"
  GH_REPO="${BASH_REMATCH[2]}"
  echo ""
  echo "GitHub Repository: https://github.com/${GH_USER}/${GH_REPO}"
  echo "GitHub Pages URL (after enabling Pages -> GitHub Actions): https://${GH_USER}.github.io/${GH_REPO}/"
fi
