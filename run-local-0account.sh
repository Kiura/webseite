#!/usr/bin/env bash
###############################################################################
# Run the UNFALLX site locally against 0account's STAGING system, to try the
# "Mit 0account anmelden" button by hand before the PR is merged.
#
#   ./run-local-0account.sh          then open http://localhost:3000/login
#
# Not part of the PR — this file is untracked on purpose (see .gitignore note
# in the PR description); it only exists to drive a manual test.
#
# NODE_ENV=test is what lets the portal use a local SQLite file instead of
# MySQL. It also switches the session cookies off __Host- prefixes, which is
# required because localhost is plain http. Do not copy these values anywhere
# near a real deployment.
###############################################################################
set -euo pipefail
cd "$(dirname "$0")"

STATE_DIR="${TMPDIR:-/tmp}/unfallx-local"
mkdir -p "$STATE_DIR"

# The staging client for app.unfallx.com. Staging-only credentials: the app row
# exists solely in 0account's staging database and grants nothing in production.
export ZEROACCOUNT_CLIENT_ID="258fe9ba-7184-4b2b-9a59-d36fe2f93fe2"
export ZEROACCOUNT_CLIENT_SECRET="staging0account_sec_dbdac0d16dd87bef223c5006bd25e1627b92318d21325bc57327e003f49aa4ec"
export ZEROACCOUNT_ISSUER="https://staging-v1.0account.com"

export NODE_ENV=test
export PORTAL_LOCAL_DB="$STATE_DIR/local.sqlite"
export PORTAL_ORIGIN="http://localhost:3000"
export PORT=3000
# node:sqlite is still behind a flag on Node 22.9.
export NODE_OPTIONS=--experimental-sqlite

echo "UNFALLX -> 0account staging"
echo "  Anbieter : $ZEROACCOUNT_ISSUER"
echo "  Datenbank: $PORTAL_LOCAL_DB (frisch löschbar)"
echo "  Login    : http://localhost:3000/login"
echo
exec node server.js
