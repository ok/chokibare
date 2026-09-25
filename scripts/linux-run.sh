#!/bin/sh
# usage: scripts/linux-run.sh <mode: node|bare|both> <test files...>  — runs chokidar4bare tests on Linux (arm64) in Docker
MODE=$1; shift
docker run --rm --platform linux/arm64 -v "$(cd "$(dirname "$0")/.." && pwd):/src:ro" -v chokidar4bare-linux-nm:/w/node_modules node:22-slim sh -c '
MODE=$1; shift
mkdir -p /w && tar --exclude=./node_modules -C /src -cf - . | tar -C /w -xf - && cd /w
npm install --no-audit --no-fund --silent 2>&1 | tail -2  # always: the cached volume must follow package.json
echo "linux $(uname -m) node $(node -v) bare $(./node_modules/.bin/bare --version)"
for f in "$@"; do
  for rt in node bare; do
    if [ "$MODE" = both ] || [ "$MODE" = $rt ]; then
      echo "== $f $rt"; npx brittle-$rt "$f" 2>&1 | grep -E "^(not ok|# tests|# asserts|# ok|# not ok)|Uncaught|timed out" | head -30
    fi
  done
done' sh "$MODE" "$@"
