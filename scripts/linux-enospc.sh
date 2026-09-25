#!/bin/sh
# Privileged Linux container: lowers the inotify limits the way the CI job does (by writing /proc/sys
# directly; the slim image has no sysctl), runs test/enospc.js under Bare, then restores them.
# The limits are kernel-global inside Docker Desktop's VM: never run this alongside another Linux test run.
docker run --rm --privileged --platform linux/arm64 -v "$(cd "$(dirname "$0")/.." && pwd):/src:ro" -v chokibare-linux-nm:/w/node_modules node:22-slim sh -c '
mkdir -p /w && tar --exclude=./node_modules -C /src -cf - . | tar -C /w -xf - && cd /w
[ -x node_modules/.bin/brittle-bare ] || npm install --no-audit --no-fund --silent 2>&1 | tail -2
W=/proc/sys/fs/inotify/max_user_watches; Q=/proc/sys/fs/inotify/max_queued_events
ORIG_W=$(cat $W); ORIG_Q=$(cat $Q)
echo "before: max_user_watches=$ORIG_W max_queued_events=$ORIG_Q"
echo 1024 > $W && echo 16 > $Q
echo "after:  max_user_watches=$(cat $W) max_queued_events=$(cat $Q)"
CHOKIBARE_TEST_ENOSPC=1 CHOKIBARE_TEST_QOVERFLOW=1 npx brittle-bare test/enospc.js 2>&1 | grep -vE "^\s+ok " | head -60
echo $ORIG_W > $W; echo $ORIG_Q > $Q
echo "restored: max_user_watches=$(cat $W) max_queued_events=$(cat $Q)"'
