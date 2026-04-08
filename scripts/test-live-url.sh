#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MCP_DIR="$ROOT_DIR/subs/mcp"
HOSTED_URL="${HOSTED_URL:-https://mcp.apiosk.com}"
HOSTED_URL="${HOSTED_URL%/}"
RUN_REMOTE_WALLET_TEST="${APIOSK_RUN_REMOTE_WALLET_TEST:-1}"
RUN_FUNDED_TESTS="${APIOSK_RUN_FUNDED_TESTS:-0}"
RUN_PUBLISH_TEST="${APIOSK_RUN_PUBLISH_TEST:-0}"
TEST_PRIVATE_KEY="${APIOSK_TEST_PRIVATE_KEY:-}"
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
  if [[ "${#CREATED_WALLET_IDS[@]}" -gt 0 ]]; then
    for wallet_id in "${CREATED_WALLET_IDS[@]}"; do
      call_mcp "$HOSTED_URL" "$(build_tool_call_payload "apiosk_wallet_delete" "{\"wallet_id\":\"$wallet_id\"}")" >/dev/null 2>&1 || true
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
  curl -fsS "$base_url/mcp" \
    -H "Accept: application/json, text/event-stream" \
    -H "Content-Type: application/json" \
    -d "$payload"
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
  if [[ -z "$args_json" ]]; then
    args_json='{}'
  fi
  call_mcp "$base_url" "$(build_tool_call_payload "$tool_name" "$args_json")" | extract_text_content
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

assert_wallet_delete_payload() {
  local payload="$1"
  local expected_wallet_id="$2"
  printf '%s' "$payload" | node -e '
const expectedWalletId = process.argv[1];
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (parsed.deleted_wallet_id !== expectedWalletId) {
    console.error(`Delete wallet mismatch. Expected ${expectedWalletId}, received ${parsed.deleted_wallet_id}`);
    process.exit(1);
  }
  console.log(`Deleted hosted wallet: ${parsed.deleted_wallet_id}`);
});
' "$expected_wallet_id"
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

echo "==> Step 2: live tool surface"
assert_tools "$HOSTED_URL" \
  "apiosk_help" \
  "apiosk_explore" \
  "apiosk_search" \
  "apiosk_get_api" \
  "apiosk_execute" \
  "apiosk_wallet_create" \
  "apiosk_configure" \
  "apiosk_wallet_delete" \
  "apiosk_publish_api"

echo "==> Step 3: live discovery flow"
search_text="$(mcp_call_text "$HOSTED_URL" "apiosk_search" '{"search":"diff","limit":3}')"
assert_search_payload "$search_text"

explore_text="$(mcp_call_text "$HOSTED_URL" "apiosk_explore" '{"listing_type":"api","search":"weather","limit":2}')"
assert_explore_payload "$explore_text"

get_text="$(mcp_call_text "$HOSTED_URL" "apiosk_get_api" '{"slug":"agent-json-diff"}')"
assert_get_api_payload "$get_text"

hosted_wallet_id=""
funded_wallet_id=""

if [[ "$RUN_REMOTE_WALLET_TEST" == "1" ]]; then
  echo "==> Step 4: live hosted wallet flow"
  hosted_wallet_text="$(mcp_call_text "$HOSTED_URL" "apiosk_wallet_create" '{"label":"Live hosted smoke wallet"}')"
  hosted_wallet_state="$(assert_wallet_create_payload "$hosted_wallet_text")"
  IFS=$'\t' read -r hosted_wallet_id hosted_wallet_address <<<"$hosted_wallet_state"
  CREATED_WALLET_IDS+=("$hosted_wallet_id")
  echo "Created hosted wallet: $hosted_wallet_id"
  echo "Hosted wallet address: $hosted_wallet_address"

  hosted_configure_text="$(mcp_call_text "$HOSTED_URL" "apiosk_configure" "{\"wallet_id\":\"$hosted_wallet_id\",\"section\":\"funding\"}")"
  assert_configure_payload "$hosted_configure_text" "$hosted_wallet_address"

  hosted_delete_text="$(mcp_call_text "$HOSTED_URL" "apiosk_wallet_delete" "{\"wallet_id\":\"$hosted_wallet_id\"}")"
  assert_wallet_delete_payload "$hosted_delete_text" "$hosted_wallet_id"
  CREATED_WALLET_IDS=()
fi

if [[ "$RUN_FUNDED_TESTS" != "1" ]]; then
  echo "==> Skipping live funded tests. Set APIOSK_RUN_FUNDED_TESTS=1 to enable them."
  echo "==> Live URL test passed"
  exit 0
fi

if [[ -z "$TEST_PRIVATE_KEY" ]]; then
  echo "APIOSK_RUN_FUNDED_TESTS=1 requires APIOSK_TEST_PRIVATE_KEY." >&2
  exit 1
fi

echo "==> Step 5: live funded pay flow"
funded_wallet_text="$(mcp_call_text "$HOSTED_URL" "apiosk_wallet_create" "$(node -e '
process.stdout.write(JSON.stringify({
  label: "Live funded smoke wallet",
  mode: "import_private_key",
  secret: process.argv[1],
  set_active: true
}));
' "$TEST_PRIVATE_KEY")")"
funded_wallet_state="$(assert_wallet_create_payload "$funded_wallet_text")"
IFS=$'\t' read -r funded_wallet_id funded_wallet_address <<<"$funded_wallet_state"
CREATED_WALLET_IDS+=("$funded_wallet_id")
echo "Imported funded hosted wallet: $funded_wallet_id"
echo "Funded hosted wallet address: $funded_wallet_address"

paid_text="$(mcp_call_text "$HOSTED_URL" "apiosk_execute" "$(node -e '
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
  echo "==> Skipping live publish lifecycle. Set APIOSK_RUN_PUBLISH_TEST=1 to enable it."
  echo "==> Live URL test passed"
  exit 0
fi

echo "==> Step 6: live publish lifecycle"
publish_slug="live-smoke-$(date +%s)"

publish_text="$(mcp_call_text "$HOSTED_URL" "apiosk_publish_api" "$(node -e '
process.stdout.write(JSON.stringify({
  wallet_id: process.argv[1],
  name: "Live Smoke API",
  slug: process.argv[2],
  endpoint_url: process.argv[3],
  price_usd: 0.001,
  description: "Temporary live smoke-test listing created by scripts/test-live-url.sh",
  listing_group: "api"
}));
' "$funded_wallet_id" "$publish_slug" "$PUBLISH_ENDPOINT_URL")")"
assert_slug_present "$publish_text" "$publish_slug"

list_text="$(mcp_call_text "$HOSTED_URL" "apiosk_list_my_apis" "{\"wallet_id\":\"$funded_wallet_id\"}")"
assert_slug_present "$list_text" "$publish_slug"

update_text="$(mcp_call_text "$HOSTED_URL" "apiosk_update_api" "$(node -e '
process.stdout.write(JSON.stringify({
  wallet_id: process.argv[1],
  slug: process.argv[2],
  description: "Updated by the live smoke test"
}));
' "$funded_wallet_id" "$publish_slug")")"
assert_slug_present "$update_text" "$publish_slug"

delete_text="$(mcp_call_text "$HOSTED_URL" "apiosk_delete_api" "{\"wallet_id\":\"$funded_wallet_id\",\"slug\":\"$publish_slug\"}")"
assert_slug_present "$delete_text" "$publish_slug"

list_text="$(mcp_call_text "$HOSTED_URL" "apiosk_list_my_apis" "{\"wallet_id\":\"$funded_wallet_id\"}")"
assert_slug_absent "$list_text" "$publish_slug"

echo "==> Live URL test passed"
