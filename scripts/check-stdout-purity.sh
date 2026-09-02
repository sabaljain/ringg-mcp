#!/usr/bin/env bash
# Static guards for the two structural invariants of this server:
#   1. Nothing outside src/transports/ writes to stdout (it carries the JSON-RPC stream).
#   2. The server core, tools and API client never import a transport.
set -uo pipefail

echo "=== stdio safety checks ==="
fail=0

# --- 1. stdout writes ------------------------------------------------------
hits=$(grep -rn --include="*.ts" -E "console\.(log|info|debug|trace)|process\.stdout" src/ \
  | grep -v "^src/transports/" || true)
if [ -n "$hits" ]; then
  echo "FAIL: stdout writes outside src/transports/:"
  echo "$hits"
  fail=1
else
  echo "PASS: no stdout writes outside src/transports/"
fi

bad=$(grep -n "process\.stdout" src/transports/*.ts || true)
if [ -n "$bad" ]; then
  echo "FAIL: direct process.stdout use in transports:"
  echo "$bad"
  fail=1
else
  echo "PASS: no direct process.stdout use in transports"
fi

# --- 2. transport isolation (imports only, so prose in comments is fine) ----
leak=$(grep -rnE "^\s*import .*(stdio|streamableHttp|sse)" \
  src/server.ts src/tools/ src/ringg/ src/config.ts src/logger.ts 2>/dev/null || true)
leak2=$(grep -rn "new StdioServerTransport" src/server.ts src/tools/ src/ringg/ 2>/dev/null || true)
if [ -n "$leak$leak2" ]; then
  echo "FAIL: a transport is imported into the transport-agnostic core:"
  [ -n "$leak" ] && echo "$leak"
  [ -n "$leak2" ] && echo "$leak2"
  fail=1
else
  echo "PASS: server core, tools and API client import no transport"
fi

# --- 3. scope guard: no tool may dial a phone ------------------------------
scope=$(grep -rnE "\"/calling/outbound|/campaign/|/campaign/terminate|POST \"/external/kb|/analytics/" \
  src/ringg/ src/tools/ 2>/dev/null | grep -v "^\s*\*" || true)
if [ -n "$scope" ]; then
  echo "FAIL: out-of-scope endpoint referenced in code:"
  echo "$scope"
  fail=1
else
  echo "PASS: no calling, campaign, termination, KB-write or analytics endpoints in code"
fi

exit $fail
