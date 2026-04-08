import os from "node:os";
import path from "node:path";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";

const DEFAULT_CONNECT_HEADER_NAME = "X-Apiosk-Connect-Token";
const DEFAULT_GATEWAY_URL = "https://gateway.apiosk.com";
const DEFAULT_DASHBOARD_URL = "https://apiosk.com";
const DEFAULT_CONTROL_PLANE_URL = "https://mcp.apiosk.com";
const DEFAULT_CHAIN_ID = 8453;
const DEFAULT_RPC_URL = "https://mainnet.base.org";
const DEFAULT_USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function trimString(value) {
  return String(value || "").trim();
}

function defaultApioskDir(env = process.env) {
  const configured = trimString(env.APIOSK_HOME);
  if (configured) return configured;

  const home = trimString(env.HOME) || os.homedir();
  return path.join(home, ".apiosk");
}

function normalizeWalletAddress(value, { optional = false } = {}) {
  const normalized = trimString(value).toLowerCase();
  if (!normalized && optional) return "";
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) {
    throw new Error("Wallet address must use a 0x-prefixed 40-byte hex address.");
  }
  return normalized;
}

function normalizeConnectToken(value, { optional = false } = {}) {
  const normalized = trimString(value);
  if (!normalized && optional) return "";
  if (!/^aw_[A-Za-z0-9_:-]+$/.test(normalized)) {
    throw new Error("Connect token must match the Apiosk managed-token format.");
  }
  return normalized;
}

async function safeChmod(filePath, mode) {
  try {
    await chmod(filePath, mode);
  } catch {
    // Best effort only; not all environments support chmod.
  }
}

async function writeAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  await mkdir(dir, { recursive: true });
  await writeFile(tempFile, value, "utf8");
  await safeChmod(tempFile, 0o600);
  await rename(tempFile, filePath);
  await safeChmod(filePath, 0o600);
}

export function createApioskLocalConfigPaths(env = process.env) {
  const apioskDir = defaultApioskDir(env);
  return {
    apioskDir,
    configFile: path.join(apioskDir, "config.json"),
    connectEnvFile: path.join(apioskDir, "connect.env"),
  };
}

export async function readLocalApioskConfig(env = process.env) {
  const { configFile } = createApioskLocalConfigPaths(env);

  try {
    const raw = await readFile(configFile, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw new Error(
      `Could not read the local Apiosk config: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export async function saveLocalApioskConfig(input = {}, env = process.env) {
  const paths = createApioskLocalConfigPaths(env);
  const existing = (await readLocalApioskConfig(env)) || {};
  const gatewayUrl = trimString(input.gateway_url || DEFAULT_GATEWAY_URL).replace(/\/+$/, "");
  const chainId = Number.parseInt(String(input.chain_id || DEFAULT_CHAIN_ID), 10) || DEFAULT_CHAIN_ID;
  const walletAddress = normalizeWalletAddress(input.agent_wallet_address || input.wallet_address, {
    optional: true,
  });
  const connectToken = normalizeConnectToken(input.connect_token, { optional: true });
  const connectAuthorization = trimString(
    input.connect_authorization || (connectToken ? `Bearer ${connectToken}` : "")
  );
  const connectHeaderName = trimString(input.connect_header_name || DEFAULT_CONNECT_HEADER_NAME);
  const dailyLimitUsdc = Number.isFinite(Number(input.daily_limit_usdc))
    ? Number(input.daily_limit_usdc)
    : 100;
  const perRequestLimitUsdc = Number.isFinite(Number(input.per_request_limit_usdc))
    ? Number(input.per_request_limit_usdc)
    : 1;

  if (!connectToken && !connectAuthorization) {
    throw new Error("A connect token or connect authorization value is required.");
  }

  const config = {
    rpc_url: DEFAULT_RPC_URL,
    chain_id: chainId,
    usdc_contract: DEFAULT_USDC_CONTRACT,
    gateway_url: gatewayUrl,
    agent_wallet_address: walletAddress || null,
    daily_limit_usdc: dailyLimitUsdc,
    per_request_limit_usdc: perRequestLimitUsdc,
    connect_token: connectToken || null,
    connect_authorization: connectAuthorization || null,
    connect_header_name: connectHeaderName || DEFAULT_CONNECT_HEADER_NAME,
    control_plane_url:
      trimString(existing.control_plane_url || env.APIOSK_CONTROL_PLANE_URL || DEFAULT_CONTROL_PLANE_URL).replace(
        /\/+$/,
        ""
      ) || null,
    dashboard_url:
      trimString(existing.dashboard_url || env.APIOSK_DASHBOARD_URL || DEFAULT_DASHBOARD_URL).replace(/\/+$/, "") ||
      null,
    dashboard_session_token: trimString(existing.dashboard_session_token) || null,
    dashboard_session_email: trimString(existing.dashboard_session_email) || null,
    dashboard_session_expires_at: Number.isFinite(Number(existing.dashboard_session_expires_at))
      ? Number(existing.dashboard_session_expires_at)
      : null,
  };

  const connectEnv = [
    `APIO_GATEWAY_URL=${gatewayUrl}`,
    `APIO_CHAIN_ID=${chainId}`,
    `APIO_AGENT_WALLET_ADDRESS=${walletAddress}`,
    `APIO_CONNECT_TOKEN=${connectToken}`,
    `APIO_CONNECT_AUTHORIZATION=${connectAuthorization}`,
    `APIO_CONNECT_HEADER_NAME=${connectHeaderName || DEFAULT_CONNECT_HEADER_NAME}`,
    `APIO_WALLET_DAILY_LIMIT_USDC=${dailyLimitUsdc}`,
    `APIO_WALLET_PER_TX_LIMIT_USDC=${perRequestLimitUsdc}`,
  ].join("\n");

  await writeAtomic(paths.configFile, `${JSON.stringify(config, null, 2)}\n`);
  await writeAtomic(paths.connectEnvFile, `${connectEnv}\n`);

  return {
    paths,
    config,
  };
}

export async function saveLocalApioskDashboardSession(input = {}, env = process.env) {
  const paths = createApioskLocalConfigPaths(env);
  const existing = (await readLocalApioskConfig(env)) || {};
  const sessionToken = trimString(input.dashboard_session_token || input.session_token);

  if (!sessionToken) {
    throw new Error("A dashboard session token is required.");
  }

  const expiresAtRaw = input.dashboard_session_expires_at ?? input.expires_at;
  const expiresAt = Number(expiresAtRaw);
  const config = {
    ...existing,
    control_plane_url:
      trimString(
        input.control_plane_url || existing.control_plane_url || env.APIOSK_CONTROL_PLANE_URL || DEFAULT_CONTROL_PLANE_URL
      ).replace(/\/+$/, "") || null,
    dashboard_url:
      trimString(input.dashboard_url || existing.dashboard_url || env.APIOSK_DASHBOARD_URL || DEFAULT_DASHBOARD_URL).replace(/\/+$/, "") ||
      null,
    dashboard_session_token: sessionToken,
    dashboard_session_email:
      trimString(input.dashboard_session_email || input.email || existing.dashboard_session_email) || null,
    dashboard_session_expires_at: Number.isFinite(expiresAt)
      ? expiresAt
      : Number.isFinite(Number(existing.dashboard_session_expires_at))
      ? Number(existing.dashboard_session_expires_at)
      : null,
  };

  await writeAtomic(paths.configFile, `${JSON.stringify(config, null, 2)}\n`);

  return {
    paths,
    config,
  };
}

export function parseConnectString(raw) {
  const lines = String(raw || "").split(/\r?\n/);
  const parsed = {
    gateway_url: "",
    chain_id: DEFAULT_CHAIN_ID,
    wallet_address: "",
    connect_token: "",
    connect_authorization: "",
    connect_header_name: DEFAULT_CONNECT_HEADER_NAME,
    daily_limit_usdc: 100,
    per_request_limit_usdc: 1,
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const normalizedLine = trimmed.startsWith("export ") ? trimmed.slice(7) : trimmed;
    const separatorIndex = normalizedLine.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = normalizedLine.slice(0, separatorIndex).trim();
    let value = normalizedLine.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key === "APIO_GATEWAY_URL") parsed.gateway_url = value;
    if (key === "APIO_CHAIN_ID") parsed.chain_id = Number.parseInt(value, 10) || DEFAULT_CHAIN_ID;
    if (key === "APIO_AGENT_WALLET_ADDRESS") parsed.wallet_address = value;
    if (key === "APIO_CONNECT_TOKEN") parsed.connect_token = value;
    if (key === "APIO_CONNECT_AUTHORIZATION") parsed.connect_authorization = value;
    if (key === "APIO_CONNECT_HEADER_NAME") parsed.connect_header_name = value || DEFAULT_CONNECT_HEADER_NAME;
    if (key === "APIO_WALLET_DAILY_LIMIT_USDC") parsed.daily_limit_usdc = Number(value) || 100;
    if (key === "APIO_WALLET_PER_TX_LIMIT_USDC") parsed.per_request_limit_usdc = Number(value) || 1;
  }

  if (!parsed.gateway_url || !parsed.wallet_address || !parsed.connect_token) {
    throw new Error("Connect string is missing one of: APIO_GATEWAY_URL, APIO_AGENT_WALLET_ADDRESS, APIO_CONNECT_TOKEN.");
  }

  return {
    gateway_url: trimString(parsed.gateway_url).replace(/\/+$/, ""),
    chain_id: parsed.chain_id || DEFAULT_CHAIN_ID,
    wallet_address: normalizeWalletAddress(parsed.wallet_address),
    connect_token: normalizeConnectToken(parsed.connect_token),
    connect_authorization:
      trimString(parsed.connect_authorization) || `Bearer ${normalizeConnectToken(parsed.connect_token)}`,
    connect_header_name: trimString(parsed.connect_header_name) || DEFAULT_CONNECT_HEADER_NAME,
    daily_limit_usdc: parsed.daily_limit_usdc,
    per_request_limit_usdc: parsed.per_request_limit_usdc,
  };
}
