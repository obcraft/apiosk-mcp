import { randomBytes } from "node:crypto";

import { privateKeyToAccount } from "viem/accounts";

function parseBody(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function pickMessage(payload, fallback) {
  if (payload && typeof payload === "object") {
    if (typeof payload.message === "string" && payload.message.trim()) {
      return payload.message.trim();
    }
    if (typeof payload.error === "string" && payload.error.trim()) {
      return payload.error.trim();
    }
  }

  if (typeof payload === "string" && payload.trim()) {
    return payload.trim();
  }

  return fallback;
}

export function buildWalletAuthMessage(action, resource, walletAddress, timestamp, nonce) {
  return [
    "Apiosk auth",
    `action:${action}`,
    `wallet:${String(walletAddress || "").toLowerCase()}`,
    `resource:${resource}`,
    `timestamp:${timestamp}`,
    `nonce:${nonce}`,
  ].join("\n");
}

async function signedRequest({
  baseUrl,
  path,
  method = "GET",
  body,
  action,
  resource,
  wallet,
  fetchImpl = globalThis.fetch,
}) {
  if (!fetchImpl) {
    throw new Error("A fetch implementation is required.");
  }

  const account = privateKeyToAccount(wallet.private_key);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString("hex");
  const message = buildWalletAuthMessage(action, resource, wallet.address, timestamp, nonce);
  const signature = await account.signMessage({ message });
  const headers = new Headers({
    accept: "application/json",
    "x-wallet-address": wallet.address,
    "x-wallet-signature": signature,
    "x-wallet-timestamp": timestamp,
    "x-wallet-nonce": nonce,
  });

  const init = {
    method,
    headers,
  };

  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }

  const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, "")}${path}`, init);
  const text = await response.text();
  const payload = parseBody(text);

  return { payload, response };
}

export async function requestGatewayManagement(options) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { response, payload } = await signedRequest(options);
    if (response.ok) {
      return payload;
    }

    if ((response.status === 401 || response.status === 403) && attempt === 0) {
      continue;
    }

    throw new Error(
      pickMessage(
        payload,
        `Gateway management request failed with HTTP ${response.status}`
      )
    );
  }

  throw new Error("Gateway management request failed.");
}
