#!/bin/sh
# Runs the server as the unprivileged `node` user.
#
# The TypeScript runner unpacks a small loader into $TMPDIR before it starts. The image sets TMPDIR to
# <data dir>/tmp so that works under a read-only root filesystem; this creates it, in case the volume is new
# or was restored from a backup taken before the directory existed.
set -e
mkdir -p "${TMPDIR:-${ORBITID_DATA_DIR:-/data}/tmp}"
exec node node_modules/tsx/dist/cli.mjs packages/server/src/cli.ts "$@"
