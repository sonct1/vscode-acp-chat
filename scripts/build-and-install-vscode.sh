#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

EXT_NAME="$(node -p "require('./package.json').name")"
EXT_VERSION="$(node -p "require('./package.json').version")"
EXT_PUBLISHER="$(node -p "require('./package.json').publisher")"
VSIX_PATH="${TMPDIR:-/tmp}/${EXT_NAME}-${EXT_VERSION}.vsix"

echo "==> Installing dependencies"
if command -v pnpm &>/dev/null && [ -f "pnpm-lock.yaml" ]; then
  pnpm install
else
  npm install
fi

echo "==> Linting"
npm run lint

echo "==> Packaging VSIX: ${VSIX_PATH}"
# --no-dependencies skips npm dependency validation which is incompatible with pnpm
npx vsce package --no-dependencies --out "$VSIX_PATH"

echo "==> Installing extension into VS Code"
code --install-extension "$VSIX_PATH" --force

echo "==> Installed extension version"
code --list-extensions --show-versions | grep -E "^${EXT_PUBLISHER}\.${EXT_NAME}@" || true

rm -f "$VSIX_PATH"
echo "Done. Run 'Developer: Reload Window' in VS Code to use the updated extension."
