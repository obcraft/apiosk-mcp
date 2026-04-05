#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MCP_DIR="$ROOT_DIR/subs/mcp"
PORT="${PORT:-3310}"
HOST="${HOST:-127.0.0.1}"
BASE_URL="http://${HOST}:${PORT}"
TMP_HOME="$(mktemp -d "${TMPDIR:-/tmp}/apiosk-mcp-smoke.XXXXXX")"
SERVER_LOG="$TMP_HOME/server.log"
SERVER_PID=""

cleanup() {
  local exit_code=$?
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_HOME"
  return "$exit_code"
}
trap cleanup EXIT INT TERM

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd node
require_cmd curl

echo "==> Repo root: $ROOT_DIR"
echo "==> Temp APIOSK_HOME: $TMP_HOME"

if [[ ! -d "$MCP_DIR/node_modules" ]]; then
  echo "==> Installing MCP dependencies"
  (cd "$MCP_DIR" && npm install)
fi

echo "==> Starting local MCP HTTP server"
(
  cd "$MCP_DIR"
  APIOSK_HOME="$TMP_HOME" \
  APIOSK_ENABLE_LOCAL_WALLETS=true \
  PORT="$PORT" \
  node server.mjs >"$SERVER_LOG" 2>&1
) &
SERVER_PID=$!

echo "==> Waiting for health endpoint"
for _ in $(seq 1 40); do
  if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
  echo "Server failed to become healthy. Log output:" >&2
  cat "$SERVER_LOG" >&2 || true
  exit 1
fi

call_mcp() {
  local payload="$1"
  curl -fsS "$BASE_URL/mcp" \
    -H "Accept: application/json, text/event-stream" \
    -H "Content-Type: application/json" \
    -d "$payload"
}

extract_text_content() {
  node -e '
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const raw = Buffer.concat(chunks).toString("utf8");
  const normalized = raw.includes("\ndata:")
    ? raw
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n")
    : raw;
  const response = JSON.parse(normalized);
  if (response.error) {
    console.error(JSON.stringify(response.error, null, 2));
    process.exit(1);
  }
  const text = response.result?.content?.[0]?.text;
  if (typeof text !== "string") {
    console.error("Missing text content in MCP response");
    process.exit(1);
  }
  process.stdout.write(text);
});
'
}

parse_jsonrpc_response() {
  node -e '
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const raw = Buffer.concat(chunks).toString("utf8");
  const normalized = raw.includes("\ndata:")
    ? raw
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n")
    : raw;
  process.stdout.write(normalized);
});
'
}

echo "==> Listing tools"
TOOLS_RAW="$(call_mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')"
printf '%s' "$TOOLS_RAW" | parse_jsonrpc_response | node -e '
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const names = (response.result?.tools || []).map((tool) => tool.name);
  const required = [
    "apiosk_help",
    "apiosk_search",
    "apiosk_wallet_create",
    "apiosk_configure",
    "apiosk_publish_api"
  ];
  for (const name of required) {
    if (!names.includes(name)) {
      console.error(`Missing expected tool: ${name}`);
      process.exit(1);
    }
  }
  console.log(`Found ${names.length} tools.`);
});
'

echo "==> Creating a local wallet"
CREATE_TEXT="$(call_mcp '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"apiosk_wallet_create","arguments":{"label":"Smoke wallet"}}}' | extract_text_content)"
WALLET_ID="$(printf '%s' "$CREATE_TEXT" | node -e '
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!payload.wallet?.id) {
    console.error("Wallet id missing from create response");
    process.exit(1);
  }
  if (!payload.configure?.funding?.receive_on_base?.qr_image_url) {
    console.error("Funding QR image URL missing from create response");
    process.exit(1);
  }
  if (!payload.configure?.options_menu?.sections?.length) {
    console.error("Configure options menu missing from create response");
    process.exit(1);
  }
  console.log(payload.wallet.id);
});
')"

echo "Created wallet: $WALLET_ID"

echo "==> Reopening configure menu"
CONFIG_TEXT="$(call_mcp "$(node -e 'process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"apiosk_configure",arguments:{wallet_id:process.argv[1],section:"funding"}}}))' "$WALLET_ID")" | extract_text_content)"
printf '%s' "$CONFIG_TEXT" | node -e '
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const funding = payload.section_payload?.receive_on_base || payload.funding?.receive_on_base;
  if (!funding?.address || !funding?.qr_image_url) {
    console.error("Funding section missing address or QR image URL");
    process.exit(1);
  }
  const menuIds = (payload.options_menu?.sections || []).map((section) => section.id);
  const expected = ["wallet", "funding", "payments", "publish", "security", "data"];
  for (const id of expected) {
    if (!menuIds.includes(id)) {
      console.error(`Missing menu section: ${id}`);
      process.exit(1);
    }
  }
  console.log(`Funding address: ${funding.address}`);
  console.log(`Funding QR URL: ${funding.qr_image_url}`);
  console.log(`Menu sections: ${menuIds.join(", ")}`);
});
'

if [[ -n "${ONRAMPER_API_KEY:-}" ]] && [[ -n "${ONRAMPER_WIDGET_SECRET:-}" ]]; then
  echo "==> Checking Onramper checkout option"
  ONRAMPER_TEXT="$(
    APIOSK_HOME="$TMP_HOME" ONRAMPER_API_KEY="$ONRAMPER_API_KEY" ONRAMPER_WIDGET_SECRET="$ONRAMPER_WIDGET_SECRET" \
    call_mcp "$(node -e 'process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:4,method:"tools/call",params:{name:"apiosk_configure",arguments:{wallet_id:process.argv[1],section:"funding",funding_provider:"onramper"}}}))' "$WALLET_ID")" | extract_text_content
  )"
  printf '%s' "$ONRAMPER_TEXT" | node -e '
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const widgetUrl = payload.funding?.selected_provider?.widget_url;
  if (!widgetUrl) {
    console.error("Onramper widget URL missing");
    process.exit(1);
  }
  console.log(`Onramper widget URL: ${widgetUrl}`);
});
'
fi

echo "==> Fresh-environment smoke test passed"
