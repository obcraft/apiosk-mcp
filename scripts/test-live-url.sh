#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MCP_DIR="$ROOT_DIR/subs/mcp"
HOSTED_URL="${HOSTED_URL:-https://mcp.apiosk.com}"
HOSTED_URL="${HOSTED_URL%/}"
RUN_REMOTE_WALLET_TEST="${APIOSK_RUN_REMOTE_WALLET_TEST:-0}"
RUN_FUNDED_TESTS="${APIOSK_RUN_FUNDED_TESTS:-0}"
RUN_PUBLISH_TEST="${APIOSK_RUN_PUBLISH_TEST:-0}"
TEST_PRIVATE_KEY="${APIOSK_TEST_PRIVATE_KEY:-}"
MCP_BEARER_TOKEN="${APIOSK_MCP_BEARER_TOKEN:-}"
PAY_TEST_SLUG="${APIOSK_PAY_TEST_SLUG:-agent-json-diff}"
PAY_TEST_OPERATION="${APIOSK_PAY_TEST_OPERATION:-/diff}"
PUBLISH_ENDPOINT_URL="${APIOSK_PUBLISH_TEST_ENDPOINT_URL:-https://httpbin.org/anything}"
CREATED_WALLET_IDS=()

normalize_bool() {
  case "${1:-0}" in
    1|true|TRUE|yes|YES) echo "1" ;;
    *) echo "0" ;;
  esac
}

RUN_REMOTE_WALLET_TEST="$(normalize_bool "$RUN_REMOTE_WALLET_TEST")"
RUN_FUNDED_TESTS="$(normalize_bool "$RUN_FUNDED_TESTS")"
RUN_PUBLISH_TEST="$(normalize_bool "$RUN_PUBLISH_TEST")"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

cleanup() {
  local exit_code=$?
  if [[ "${#CREATED_WALLET_IDS[@]}" -gt 0 && -n "$MCP_BEARER_TOKEN" ]]; then
    for wallet_id in "${CREATED_WALLET_IDS[@]}"; do
      call_mcp "$HOSTED_URL" "$(build_tool_call_payload "apiosk_delete_wallet" "{\"wallet_id\":\"$wallet_id\"}")" "$MCP_BEARER_TOKEN" >/dev/null 2>&1 || true
    done
  fi
  return "$exit_code"
}
trap cleanup EXIT INT TERM

require_cmd node
require_cmd npm
require_cmd curl

echo "==> Apiosk live URL test runner"
echo "==> Repo root: $ROOT_DIR"
echo "==> MCP dir: $MCP_DIR"
echo "==> Hosted URL: $HOSTED_URL"

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
    -H "Accept: application/json, text/event-stream" \
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
  if (!parsed.detail?.slug) {
    console.error("Get API payload is missing detail.slug.");
    process.exit(1);
  }
  if (!parsed.metadata?.execute?.path) {
    console.error("Get API payload is missing metadata.execute.path.");
    process.exit(1);
  }
  console.log(`Get API returned ${parsed.detail.slug}.`);
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

assert_wallet_list_payload() {
  local payload="$1"
  printf '%s' "$payload" | node -e '
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!Array.isArray(parsed.wallets)) {
    console.error("Wallet list payload is missing wallets[].");
    process.exit(1);
  }
  console.log(`Authenticated wallet list returned ${parsed.wallets.length} wallet(s).`);
});
'
}

assert_dashboard_wallet_payload() {
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

echo "==> Step 1: live health"
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
  console.log(`Hosted version: ${parsed.server?.version} (${parsed.tool_count} tools)`);
});
'

echo "==> Step 2: live OAuth metadata"
assert_oauth_metadata "$HOSTED_URL"
assert_protected_resource_metadata "$HOSTED_URL"
assert_control_plane_auth_proxy "$HOSTED_URL"

echo "==> Step 3: live tool surface"
assert_tools "$HOSTED_URL" \
  "apiosk_help" \
  "apiosk_explore" \
  "apiosk_search" \
  "apiosk_get_api" \
  "apiosk_execute" \
  "apiosk_list_wallets" \
  "apiosk_create_wallet" \
  "apiosk_buy_credits"

echo "==> Step 4: live discovery flow"
search_text="$(mcp_call_text "$HOSTED_URL" "apiosk_search" '{"search":"diff","limit":3}')"
assert_search_payload "$search_text"

explore_text="$(mcp_call_text "$HOSTED_URL" "apiosk_explore" '{"listing_type":"api","search":"weather","limit":2}')"
assert_explore_payload "$explore_text"

get_text="$(mcp_call_text "$HOSTED_URL" "apiosk_get_api" '{"slug":"agent-json-diff"}')"
assert_get_api_payload "$get_text"

echo "==> Step 5: protected tools must challenge without auth"
assert_protected_call_requires_auth "$HOSTED_URL" "apiosk_list_wallets" "{}"

echo "==> Step 6: optional authenticated protected-tool check"
if [[ "$RUN_REMOTE_WALLET_TEST" == "1" ]]; then
  if [[ -z "$MCP_BEARER_TOKEN" ]]; then
    echo "APIOSK_RUN_REMOTE_WALLET_TEST=1 requires APIOSK_MCP_BEARER_TOKEN." >&2
    exit 1
  fi
  wallet_list_text="$(mcp_call_text "$HOSTED_URL" "apiosk_list_wallets" '{}' "$MCP_BEARER_TOKEN")"
  assert_wallet_list_payload "$wallet_list_text"
else
  echo "==> Skipping authenticated protected-tool check. Set APIOSK_RUN_REMOTE_WALLET_TEST=1 and APIOSK_MCP_BEARER_TOKEN=... to enable it."
fi

if [[ "$RUN_FUNDED_TESTS" != "1" ]]; then
  echo "==> Skipping live funded tests. Set APIOSK_RUN_FUNDED_TESTS=1 to enable them."
  echo "==> Live URL test passed"
  exit 0
fi

if [[ -z "$MCP_BEARER_TOKEN" ]]; then
  echo "APIOSK_RUN_FUNDED_TESTS=1 requires APIOSK_MCP_BEARER_TOKEN." >&2
  exit 1
fi

echo "==> Step 7: live funded pay flow"
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

if [[ "$RUN_PUBLISH_TEST" != "1" ]]; then
  echo "==> Skipping live publish lifecycle. Use the local suite for publish lifecycle verification."
  echo "==> Live URL test passed"
  exit 0
fi

echo "Hosted publish lifecycle is no longer part of the safe live suite." >&2
exit 1

echo "==> Live URL test passed"
