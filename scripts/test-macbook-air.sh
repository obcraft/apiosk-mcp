#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MCP_DIR="$ROOT_DIR/subs/mcp"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-3312}"
LOCAL_URL="http://${HOST}:${PORT}"
HOSTED_URL="${HOSTED_URL:-https://mcp.apiosk.com}"
HOSTED_URL="${HOSTED_URL%/}"
TARGET="${TARGET:-both}"
RUN_REMOTE_WALLET_TEST="${APIOSK_RUN_REMOTE_WALLET_TEST:-0}"
RUN_FUNDED_TESTS="${APIOSK_RUN_FUNDED_TESTS:-0}"
RUN_PUBLISH_TEST="${APIOSK_RUN_PUBLISH_TEST:-0}"
TEST_PRIVATE_KEY="${APIOSK_TEST_PRIVATE_KEY:-}"
MCP_BEARER_TOKEN="${APIOSK_MCP_BEARER_TOKEN:-}"
PAY_TEST_SLUG="${APIOSK_PAY_TEST_SLUG:-agent-json-diff}"
PAY_TEST_OPERATION="${APIOSK_PAY_TEST_OPERATION:-/diff}"
PUBLISH_ENDPOINT_URL="${APIOSK_PUBLISH_TEST_ENDPOINT_URL:-https://httpbin.org/anything}"
TMP_HOME="$(mktemp -d "${TMPDIR:-/tmp}/apiosk-mcp-macbook.XXXXXX")"
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

normalize_bool() {
  case "${1:-0}" in
    1|true|TRUE|yes|YES) echo "1" ;;
    *) echo "0" ;;
  esac
}

RUN_REMOTE_WALLET_TEST="$(normalize_bool "$RUN_REMOTE_WALLET_TEST")"
RUN_FUNDED_TESTS="$(normalize_bool "$RUN_FUNDED_TESTS")"
RUN_PUBLISH_TEST="$(normalize_bool "$RUN_PUBLISH_TEST")"

case "$TARGET" in
  local|hosted|both)
    ;;
  *)
    echo "TARGET must be one of: local, hosted, both" >&2
    exit 1
    ;;
esac

require_cmd node
require_cmd npm
require_cmd curl

echo "==> Apiosk MacBook Air test runner"
echo "==> Repo root: $ROOT_DIR"
echo "==> MCP dir: $MCP_DIR"
echo "==> Local URL: $LOCAL_URL"
echo "==> Hosted URL: $HOSTED_URL"
echo "==> Target: $TARGET"
echo "==> Temp APIOSK_HOME: $TMP_HOME"

if [[ ! -d "$MCP_DIR/node_modules" ]]; then
  echo "==> Installing MCP dependencies"
  (cd "$MCP_DIR" && npm install)
fi

wait_for_health() {
  local base_url="$1"
  for _ in $(seq 1 60); do
    if curl -fsS "$base_url/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

call_mcp() {
  local base_url="$1"
  local payload="$2"
  local bearer_token="${3-}"
  local curl_args=(
    -fsS
    "$base_url/mcp"
    -H "Accept: application/json, text/event-stream"
    -H "Content-Type: application/json"
    -d "$payload"
  )
  if [[ -n "$bearer_token" ]]; then
    curl_args+=(-H "Authorization: Bearer $bearer_token")
  fi
  curl "${curl_args[@]}"
}

call_mcp_with_headers() {
  local base_url="$1"
  local payload="$2"
  local bearer_token="${3-}"
  local curl_args=(
    -i
    -sS
    "$base_url/mcp"
    -H "Accept: application/json, text/event-stream"
    -H "Content-Type: application/json"
    -d "$payload"
  )
  if [[ -n "$bearer_token" ]]; then
    curl_args+=(-H "Authorization: Bearer $bearer_token")
  fi
  curl "${curl_args[@]}"
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

build_tool_call_payload() {
  local tool_name="$1"
  local tool_args_json="${2-}"
  if [[ -z "$tool_args_json" ]]; then
    tool_args_json='{}'
  fi

  TOOL_NAME="$tool_name" TOOL_ARGS_JSON="$tool_args_json" node -e '
const name = process.env.TOOL_NAME;
const args = JSON.parse(process.env.TOOL_ARGS_JSON || "{}");
process.stdout.write(JSON.stringify({
  jsonrpc: "2.0",
  id: Date.now(),
  method: "tools/call",
  params: { name, arguments: args }
}));
'
}

mcp_call_text() {
  local base_url="$1"
  local tool_name="$2"
  local args_json="${3-}"
  local bearer_token="${4-}"
  if [[ -z "$args_json" ]]; then
    args_json='{}'
  fi
  call_mcp "$base_url" "$(build_tool_call_payload "$tool_name" "$args_json")" "$bearer_token" | extract_text_content
}

assert_tools() {
  local base_url="$1"
  shift
  local raw
  raw="$(call_mcp "$base_url" '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')"
  printf '%s' "$raw" | parse_jsonrpc_response | node -e '
const required = process.argv.slice(1);
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const names = (response.result?.tools || []).map((tool) => tool.name);
  for (const name of required) {
    if (!names.includes(name)) {
      console.error(`Missing expected tool: ${name}`);
      process.exit(1);
    }
  }
  console.log(`Found ${names.length} tools.`);
});
' "$@"
}

assert_search_payload() {
  local payload="$1"
  printf '%s' "$payload" | node -e '
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!Array.isArray(parsed.apis) || parsed.apis.length === 0) {
    console.error("Search returned no APIs.");
    process.exit(1);
  }
  if (!parsed.apis.some((api) => api.slug === "agent-json-diff")) {
    console.error("Search did not include agent-json-diff.");
    process.exit(1);
  }
  console.log(`Search returned ${parsed.apis.length} APIs for ${parsed.meta?.search}.`);
});
'
}

assert_explore_payload() {
  local payload="$1"
  printf '%s' "$payload" | node -e '
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (parsed.listing_type !== "api") {
    console.error(`Expected listing_type=api, received: ${parsed.listing_type}`);
    process.exit(1);
  }
  if (!Array.isArray(parsed.apis) || parsed.apis.length === 0) {
    console.error("Explore returned no APIs.");
    process.exit(1);
  }
  console.log(`Explore returned ${parsed.apis.length} APIs for ${parsed.meta?.search}.`);
});
'
}

assert_get_api_payload() {
  local payload="$1"
  printf '%s' "$payload" | node -e '
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (parsed.detail?.slug !== "agent-json-diff") {
    console.error("Get API returned the wrong slug.");
    process.exit(1);
  }
  if (parsed.metadata?.execute?.default_operation !== "/diff") {
    console.error("Get API metadata is missing the expected default operation.");
    process.exit(1);
  }
  console.log(`Get API returned ${parsed.detail.name}.`);
});
'
}

assert_health_payload() {
  local payload="$1"
  printf '%s' "$payload" | node -e '
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const expected = ["apiosk_explore", "apiosk_metadata", "apiosk_execute", "apiosk_health"];
  if (parsed.status !== "ok") {
    console.error(`Health returned unexpected status: ${parsed.status}`);
    process.exit(1);
  }
  if (parsed.gateway?.status !== "ok") {
    console.error(`Gateway health returned unexpected status: ${parsed.gateway?.status}`);
    process.exit(1);
  }
  if (JSON.stringify(parsed.mcp?.tools || []) !== JSON.stringify(expected)) {
    console.error(`Hosted MCP surface mismatch: ${JSON.stringify(parsed.mcp?.tools || [])}`);
    process.exit(1);
  }
  console.log(`Health exposed ${expected.length} hosted tools.`);
});
'
}

assert_oauth_metadata() {
  local base_url="$1"
  curl -fsS "$base_url/.well-known/oauth-authorization-server" | node -e '
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const requiredScopes = ["mcp:tools", "offline_access"];
  if (!parsed.issuer || !parsed.authorization_endpoint || !parsed.token_endpoint || !parsed.registration_endpoint) {
    console.error("OAuth metadata is missing issuer or required endpoints.");
    process.exit(1);
  }
  for (const scope of requiredScopes) {
    if (!parsed.scopes_supported?.includes(scope)) {
      console.error(`OAuth metadata is missing required scope ${scope}.`);
      process.exit(1);
    }
  }
  if (!parsed.grant_types_supported?.includes("refresh_token")) {
    console.error("OAuth metadata is missing refresh_token grant support.");
    process.exit(1);
  }
  console.log(`OAuth metadata OK for issuer ${parsed.issuer}`);
});
'
}

assert_protected_resource_metadata() {
  local base_url="$1"
  curl -fsS "$base_url/.well-known/oauth-protected-resource/mcp" | node -e '
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const requiredScopes = ["mcp:tools", "offline_access"];
  if (!parsed.resource || !Array.isArray(parsed.authorization_servers) || parsed.authorization_servers.length === 0) {
    console.error("Protected-resource metadata is missing resource or authorization_servers.");
    process.exit(1);
  }
  for (const scope of requiredScopes) {
    if (!parsed.scopes_supported?.includes(scope)) {
      console.error(`Protected-resource metadata is missing required scope ${scope}.`);
      process.exit(1);
    }
  }
  console.log(`Protected-resource metadata OK for ${parsed.resource}`);
});
'
}

assert_control_plane_auth_proxy() {
  local base_url="$1"
  curl -i -sS "$base_url/api/auth/mcp-sign-in" \
    -H "Content-Type: application/json" \
    -d '{"email":"invalid@example.com","password":"bad-password"}' | node -e '
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const raw = Buffer.concat(chunks).toString("utf8");
  const parts = raw.split(/\r?\n\r?\n/);
  const headerBlock = parts.shift() || "";
  const body = parts.join("\n\n");
  const statusLine = headerBlock.split(/\r?\n/)[0] || "";
  const statusMatch = statusLine.match(/\s(\d{3})\s/);
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  if (status !== 401) {
    console.error(`Expected proxied sign-in route to return 401 for invalid credentials, received ${status || "unknown"}.`);
    process.exit(1);
  }
  const parsed = JSON.parse(body);
  if (parsed.error !== "signin_failed") {
    console.error(`Expected signin_failed payload from proxied sign-in route, received ${parsed.error || "unknown"}.`);
    process.exit(1);
  }
  console.log("Hosted MCP auth proxy points at the real dashboard sign-in route.");
});
'
}

assert_protected_call_requires_auth() {
  local base_url="$1"
  local tool_name="$2"
  local args_json="${3-}"
  local raw
  raw="$(call_mcp_with_headers "$base_url" "$(build_tool_call_payload "$tool_name" "$args_json")")"
  printf '%s' "$raw" | node -e '
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const raw = Buffer.concat(chunks).toString("utf8");
  const parts = raw.split(/\r?\n\r?\n/);
  const headerBlock = parts.shift() || "";
  const body = parts.join("\n\n");
  const statusLine = headerBlock.split(/\r?\n/)[0] || "";
  const statusMatch = statusLine.match(/\s(\d{3})\s/);
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  const wwwAuthenticate = (headerBlock.match(/^www-authenticate:\s*(.+)$/im) || [])[1] || "";
  if (status !== 401) {
    console.error(`Expected 401 auth challenge, received ${status || "unknown"}.`);
    process.exit(1);
  }
  if (!/scope="mcp:tools"/.test(wwwAuthenticate)) {
    console.error("WWW-Authenticate header is missing the mcp:tools scope.");
    process.exit(1);
  }
  if (!/resource_metadata=/.test(wwwAuthenticate)) {
    console.error("WWW-Authenticate header is missing resource_metadata.");
    process.exit(1);
  }
  const parsed = JSON.parse(body);
  if (parsed.error !== "invalid_token") {
    console.error(`Expected invalid_token error body, received ${parsed.error || "unknown"}.`);
    process.exit(1);
  }
  console.log("Protected tool correctly returned an OAuth auth challenge.");
});
'
}

assert_wallet_create_payload() {
  local payload="$1"
  printf '%s' "$payload" | node -e '
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const funding = parsed.configure?.funding?.receive_on_base;
  const menuIds = (parsed.configure?.options_menu?.sections || []).map((section) => section.id);
  const expected = ["wallet", "funding", "payments", "publish", "security", "data"];
  if (!parsed.wallet?.id || !parsed.wallet?.address) {
    console.error("Wallet creation response is missing wallet id or address.");
    process.exit(1);
  }
  if (!funding?.qr_image_url) {
    console.error("Wallet creation response is missing the funding QR URL.");
    process.exit(1);
  }
  for (const id of expected) {
    if (!menuIds.includes(id)) {
      console.error(`Missing configure menu section: ${id}`);
      process.exit(1);
    }
  }
  process.stdout.write([parsed.wallet.id, parsed.wallet.address].join("\t"));
});
'
}

assert_wallet_list_payload() {
  local payload="$1"
  local wallet_id="$2"
  printf '%s' "$payload" | node -e '
const walletId = process.argv[1];
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const wallets = parsed.wallets || [];
  if (!wallets.some((wallet) => wallet.id === walletId && wallet.active === true)) {
    console.error(`Wallet list does not contain active wallet ${walletId}.`);
    process.exit(1);
  }
  console.log(`Wallet list contains ${wallets.length} wallet(s).`);
});
' "$wallet_id"
}

assert_configure_payload() {
  local payload="$1"
  local expected_address="$2"
  printf '%s' "$payload" | node -e '
const expectedAddress = process.argv[1];
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const funding = parsed.section_payload?.receive_on_base || parsed.funding?.receive_on_base;
  if (!funding?.address || !funding?.qr_image_url) {
    console.error("Configure funding payload is missing address or QR image URL.");
    process.exit(1);
  }
  if (String(funding.address).toLowerCase() !== String(expectedAddress).toLowerCase()) {
    console.error(`Configure address mismatch. Expected ${expectedAddress}, received ${funding.address}`);
    process.exit(1);
  }
  console.log(`Configure funding address: ${funding.address}`);
});
' "$expected_address"
}

assert_secret_save_payload() {
  local payload="$1"
  local expected_path="$2"
  printf '%s' "$payload" | node -e '
const expectedPath = process.argv[1];
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (parsed.saved_to !== expectedPath) {
    console.error(`Secret export path mismatch. Expected ${expectedPath}, received ${parsed.saved_to}`);
    process.exit(1);
  }
  if (parsed.format !== "txt") {
    console.error(`Expected txt secret export, received ${parsed.format}`);
    process.exit(1);
  }
  console.log(`Secret export saved to ${parsed.saved_to}`);
});
' "$expected_path"
}

assert_paid_execute_payload() {
  local payload="$1"
  local expected_slug="$2"
  printf '%s' "$payload" | node -e '
const expectedSlug = process.argv[1];
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (parsed.status !== "success") {
    console.error(`Paid execute failed with status: ${parsed.status || "unknown"}`);
    process.exit(1);
  }
  if (parsed.api !== expectedSlug) {
    console.error(`Paid execute returned wrong api slug: ${parsed.api}`);
    process.exit(1);
  }
  console.log(`Paid execute succeeded for ${parsed.api} at cost $${parsed.cost}.`);
});
' "$expected_slug"
}

assert_slug_present() {
  local payload="$1"
  local expected_slug="$2"
  printf '%s' "$payload" | node -e '
const expectedSlug = process.argv[1];
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const serialized = JSON.stringify(parsed);
  if (!serialized.includes(`"slug":"${expectedSlug}"`)) {
    console.error(`Expected slug ${expectedSlug} in response payload.`);
    process.exit(1);
  }
  console.log(`Confirmed slug ${expectedSlug} in response payload.`);
});
' "$expected_slug"
}

assert_slug_absent() {
  local payload="$1"
  local expected_slug="$2"
  printf '%s' "$payload" | node -e '
const expectedSlug = process.argv[1];
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const serialized = JSON.stringify(parsed);
  if (serialized.includes(`"slug":"${expectedSlug}"`)) {
    console.error(`Slug ${expectedSlug} is still present after delete.`);
    process.exit(1);
  }
  console.log(`Confirmed slug ${expectedSlug} is absent after delete.`);
});
' "$expected_slug"
}

assert_hosted_wallets_payload() {
  local payload="$1"
  printf '%s' "$payload" | node -e '
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!Array.isArray(parsed.wallets)) {
    console.error("Hosted wallet list payload is missing wallets[].");
    process.exit(1);
  }
  console.log(`Hosted wallet list returned ${parsed.wallets.length} wallet(s).`);
});
'
}

start_local_server() {
  echo "==> Starting local MCP HTTP server"
  (
    cd "$MCP_DIR"
    APIOSK_HOME="$TMP_HOME" \
    APIOSK_ENABLE_LOCAL_WALLETS=true \
    PORT="$PORT" \
    node server.mjs >"$SERVER_LOG" 2>&1
  ) &
  SERVER_PID=$!

  echo "==> Waiting for local health endpoint"
  if ! wait_for_health "$LOCAL_URL"; then
    echo "Local server failed to become healthy. Log output:" >&2
    cat "$SERVER_LOG" >&2 || true
    exit 1
  fi
}

run_local_core_suite() {
  local wallet_create_text wallet_state wallet_id wallet_address
  local wallet_list_text configure_text search_text explore_text get_text save_text
  local export_path

  echo "==> Local suite: tools and discovery"
  assert_tools "$LOCAL_URL" \
    "apiosk_help" \
    "apiosk_explore" \
    "apiosk_search" \
    "apiosk_get_api" \
    "apiosk_execute" \
    "apiosk_wallet_create" \
    "apiosk_configure" \
    "apiosk_wallet_save_secret" \
    "apiosk_publish_api"

  search_text="$(mcp_call_text "$LOCAL_URL" "apiosk_search" '{"search":"diff","limit":2}')"
  assert_search_payload "$search_text"

  explore_text="$(mcp_call_text "$LOCAL_URL" "apiosk_explore" '{"listing_type":"api","search":"weather","limit":2}')"
  assert_explore_payload "$explore_text"

  get_text="$(mcp_call_text "$LOCAL_URL" "apiosk_get_api" '{"slug":"agent-json-diff"}')"
  assert_get_api_payload "$get_text"

  echo "==> Local suite: wallet create/configure/save"
  wallet_create_text="$(mcp_call_text "$LOCAL_URL" "apiosk_wallet_create" '{"label":"MacBook Air test wallet","include_qr_data_url":true}')"
  wallet_state="$(assert_wallet_create_payload "$wallet_create_text")"
  IFS=$'\t' read -r wallet_id wallet_address <<<"$wallet_state"
  echo "Created wallet: $wallet_id"
  echo "Wallet address: $wallet_address"

  if [[ ! -f "$TMP_HOME/wallet.json" ]] || [[ ! -f "$TMP_HOME/wallet.txt" ]]; then
    echo "Active wallet mirror files were not written to APIOSK_HOME." >&2
    exit 1
  fi
  echo "Active wallet mirror files exist."

  wallet_list_text="$(mcp_call_text "$LOCAL_URL" "apiosk_wallet_list" '{}')"
  assert_wallet_list_payload "$wallet_list_text" "$wallet_id"

  configure_text="$(mcp_call_text "$LOCAL_URL" "apiosk_configure" "{\"wallet_id\":\"$wallet_id\",\"section\":\"funding\"}")"
  assert_configure_payload "$configure_text" "$wallet_address"

  export_path="$TMP_HOME/exports/macbook-air-wallet.txt"
  save_text="$(mcp_call_text "$LOCAL_URL" "apiosk_wallet_save_secret" "{\"wallet_id\":\"$wallet_id\",\"path\":\"$export_path\",\"format\":\"txt\"}")"
  assert_secret_save_payload "$save_text" "$export_path"

  if [[ ! -f "$export_path" ]]; then
    echo "Secret export file was not created at $export_path." >&2
    exit 1
  fi
  echo "Secret export file exists."
}

run_funded_suite() {
  local imported_text imported_state funded_wallet_id funded_wallet_address
  local paid_text publish_slug publish_text list_text update_text delete_text

  if [[ "$RUN_FUNDED_TESTS" != "1" ]]; then
    echo "==> Skipping funded pay/publish tests. Set APIOSK_RUN_FUNDED_TESTS=1 to enable them."
    return 0
  fi

  if [[ -z "$TEST_PRIVATE_KEY" ]]; then
    echo "APIOSK_RUN_FUNDED_TESTS=1 requires APIOSK_TEST_PRIVATE_KEY." >&2
    exit 1
  fi

  echo "==> Local suite: funded pay flow"
  imported_text="$(mcp_call_text "$LOCAL_URL" "apiosk_wallet_create" "$(node -e '
process.stdout.write(JSON.stringify({
  label: "MacBook Air funded test wallet",
  mode: "import_private_key",
  secret: process.argv[1],
  set_active: true
}));
' "$TEST_PRIVATE_KEY")")"
  imported_state="$(assert_wallet_create_payload "$imported_text")"
  IFS=$'\t' read -r funded_wallet_id funded_wallet_address <<<"$imported_state"
  echo "Imported funded wallet: $funded_wallet_id"
  echo "Funded wallet address: $funded_wallet_address"

  paid_text="$(mcp_call_text "$LOCAL_URL" "apiosk_execute" "$(node -e '
process.stdout.write(JSON.stringify({
  slug: process.argv[1],
  operation: process.argv[2],
  input: {
    before: { ok: true, version: 1 },
    after: { ok: false, version: 2 }
  }
}));
' "$PAY_TEST_SLUG" "$PAY_TEST_OPERATION")")"
  assert_paid_execute_payload "$paid_text" "$PAY_TEST_SLUG"

  if [[ "$RUN_PUBLISH_TEST" != "1" ]]; then
    echo "==> Skipping publish lifecycle test. Set APIOSK_RUN_PUBLISH_TEST=1 to enable it."
    return 0
  fi

  echo "==> Local suite: publish lifecycle"
  publish_slug="macbook-air-smoke-$(date +%s)"

  publish_text="$(mcp_call_text "$LOCAL_URL" "apiosk_publish_api" "$(node -e '
process.stdout.write(JSON.stringify({
  wallet_id: process.argv[1],
  name: "MacBook Air Smoke API",
  slug: process.argv[2],
  endpoint_url: process.argv[3],
  price_usd: 0.001,
  description: "Temporary smoke-test listing created by scripts/test-macbook-air.sh",
  listing_group: "api"
}));
' "$funded_wallet_id" "$publish_slug" "$PUBLISH_ENDPOINT_URL")")"
  assert_slug_present "$publish_text" "$publish_slug"

  list_text="$(mcp_call_text "$LOCAL_URL" "apiosk_list_my_apis" "{\"wallet_id\":\"$funded_wallet_id\"}")"
  assert_slug_present "$list_text" "$publish_slug"

  update_text="$(mcp_call_text "$LOCAL_URL" "apiosk_update_api" "$(node -e '
process.stdout.write(JSON.stringify({
  wallet_id: process.argv[1],
  slug: process.argv[2],
  description: "Updated by the MacBook Air smoke test"
}));
' "$funded_wallet_id" "$publish_slug")")"
  assert_slug_present "$update_text" "$publish_slug"

  delete_text="$(mcp_call_text "$LOCAL_URL" "apiosk_delete_api" "{\"wallet_id\":\"$funded_wallet_id\",\"slug\":\"$publish_slug\"}")"
  assert_slug_present "$delete_text" "$publish_slug"

  list_text="$(mcp_call_text "$LOCAL_URL" "apiosk_list_my_apis" "{\"wallet_id\":\"$funded_wallet_id\"}")"
  assert_slug_absent "$list_text" "$publish_slug"
}

run_hosted_suite() {
  local search_text explore_text get_text wallet_list_text paid_text

  echo "==> Hosted suite: health and tool surface"
  if ! wait_for_health "$HOSTED_URL"; then
    echo "Hosted server did not pass the health check: $HOSTED_URL/health" >&2
    exit 1
  fi

  curl -fsS "$HOSTED_URL/health" | node -e '
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (parsed.status !== "ok") {
    console.error(`Hosted health status is ${parsed.status}`);
    process.exit(1);
  }
  if (!parsed.server?.version) {
    console.error("Hosted health payload is missing the server version.");
    process.exit(1);
  }
  console.log(`Hosted version: ${parsed.server.version} (${parsed.tool_count} tools)`);
});
'

  assert_oauth_metadata "$HOSTED_URL"
  assert_protected_resource_metadata "$HOSTED_URL"
  assert_control_plane_auth_proxy "$HOSTED_URL"

  assert_tools "$HOSTED_URL" \
    "apiosk_explore" \
    "apiosk_metadata" \
    "apiosk_execute" \
    "apiosk_health"

  explore_text="$(mcp_call_text "$HOSTED_URL" "apiosk_explore" '{"listing_type":"api","search":"weather","limit":2}')"
  assert_explore_payload "$explore_text"

  get_text="$(mcp_call_text "$HOSTED_URL" "apiosk_metadata" '{"slug":"agent-json-diff"}')"
  assert_get_api_payload "$get_text"

  health_text="$(mcp_call_text "$HOSTED_URL" "apiosk_health" '{}')"
  assert_health_payload "$health_text"

  assert_protected_call_requires_auth "$HOSTED_URL" "apiosk_execute" '{"slug":"agent-json-diff","input":{"before":{"ok":true},"after":{"ok":false}}}'

  if [[ "$RUN_REMOTE_WALLET_TEST" == "1" ]]; then
    if [[ -z "$MCP_BEARER_TOKEN" ]]; then
      echo "APIOSK_RUN_REMOTE_WALLET_TEST=1 requires APIOSK_MCP_BEARER_TOKEN." >&2
      exit 1
    fi
    echo "==> Hosted suite: authenticated protected execute check"
    paid_text="$(mcp_call_text "$HOSTED_URL" "apiosk_execute" "$(node -e '
process.stdout.write(JSON.stringify({
  slug: process.argv[1],
  operation: process.argv[2],
  input: {
    before: { ok: true, version: 1 },
    after: { ok: false, version: 2 }
  }
}));
' "$PAY_TEST_SLUG" "$PAY_TEST_OPERATION")" "$MCP_BEARER_TOKEN")"
    assert_paid_execute_payload "$paid_text" "$PAY_TEST_SLUG"
  else
    echo "==> Skipping authenticated hosted protected execute check. Set APIOSK_RUN_REMOTE_WALLET_TEST=1 and APIOSK_MCP_BEARER_TOKEN=... to enable it."
  fi

  if [[ "$RUN_FUNDED_TESTS" != "1" ]]; then
    return 0
  fi

  if [[ -z "$MCP_BEARER_TOKEN" ]]; then
    echo "Hosted funded tests require APIOSK_MCP_BEARER_TOKEN." >&2
    exit 1
  fi

  echo "==> Hosted suite: funded execute through hosted OAuth"
  paid_text="$(mcp_call_text "$HOSTED_URL" "apiosk_execute" "$(node -e '
process.stdout.write(JSON.stringify({
  slug: process.argv[1],
  operation: process.argv[2],
  input: {
    before: { ok: true, version: 1 },
    after: { ok: false, version: 2 }
  }
}));
' "$PAY_TEST_SLUG" "$PAY_TEST_OPERATION")" "$MCP_BEARER_TOKEN")"
  assert_paid_execute_payload "$paid_text" "$PAY_TEST_SLUG"

  if [[ "$RUN_PUBLISH_TEST" == "1" ]]; then
    echo "Hosted publish lifecycle is not part of the MacBook Air hosted suite. Use the local funded suite for publish verification." >&2
    exit 1
  fi
}

echo "==> Step 1: unit tests"
(cd "$MCP_DIR" && npm test)

echo "==> Step 2: fresh-environment smoke"
(cd "$MCP_DIR" && bash scripts/smoke-new-env.sh)

if [[ "$TARGET" == "local" || "$TARGET" == "both" ]]; then
  echo "==> Step 3: local end-to-end suite"
  start_local_server
  run_local_core_suite
  run_funded_suite
fi

if [[ "$TARGET" == "hosted" || "$TARGET" == "both" ]]; then
  echo "==> Step 4: hosted verification suite"
  run_hosted_suite
fi

echo "==> MacBook Air test run passed"
