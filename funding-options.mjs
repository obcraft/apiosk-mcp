import { createHmac } from "node:crypto";

import QRCode from "qrcode";

const TRANSAK_API_URL = "https://api-gateway.transak.com";
const ONRAMPER_WIDGET_URL = "https://buy.onramper.com";
const BASE_EXPLORER_URL = "https://basescan.org";

function trimString(value) {
  return String(value || "").trim();
}

function boolFromEnv(value, defaultValue = true) {
  const normalized = trimString(value).toLowerCase();
  if (!normalized) return defaultValue;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  return defaultValue;
}

function qrImageUrl(value) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(value)}`;
}

function getOnramperConfig(env = process.env) {
  return {
    apiKey: trimString(env.ONRAMPER_API_KEY),
    widgetSecret: trimString(env.ONRAMPER_WIDGET_SECRET),
  };
}

function getTransakConfig(env = process.env) {
  return {
    apiKey: trimString(env.TRANSAK_API_KEY),
    secret: trimString(env.TRANSAK_SECRET),
    referrerDomain: trimString(env.APIOSK_TRANSAK_REFERRER_DOMAIN || "dashboard.apiosk.com"),
  };
}

function buildOnramperWidgetUrl(address, env = process.env) {
  const { apiKey, widgetSecret } = getOnramperConfig(env);
  const normalizedAddress = trimString(address).toLowerCase();
  const searchParams = new URLSearchParams({
    apiKey,
    mode: "buy",
    defaultCrypto: "USDC",
    defaultNetwork: "base",
    onlyCryptoNetworks: "base",
    networkWallets: `base:${normalizedAddress}`,
  });

  const signContent = `networkWallets=base:${normalizedAddress}`;
  const signature = createHmac("sha256", widgetSecret)
    .update(signContent)
    .digest("hex");

  searchParams.set("signature", signature);

  return `${ONRAMPER_WIDGET_URL}/?${searchParams.toString()}`;
}

async function getTransakAccessToken(env = process.env, fetchImpl = globalThis.fetch) {
  const { apiKey, secret } = getTransakConfig(env);
  const response = await fetchImpl(`${TRANSAK_API_URL}/api/v2/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey,
      secretKey: secret,
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to get Transak access token.");
  }

  const data = await response.json();
  return String(data.accessToken || "");
}

async function createTransakFundingSession(address, env = process.env, fetchImpl = globalThis.fetch) {
  const { apiKey, referrerDomain } = getTransakConfig(env);
  const accessToken = await getTransakAccessToken(env, fetchImpl);

  const sessionResponse = await fetchImpl(`${TRANSAK_API_URL}/api/v2/auth/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "access-token": accessToken,
    },
    body: JSON.stringify({
      widgetParams: {
        apiKey,
        referrerDomain,
        walletAddress: address,
        cryptoCurrencyCode: "USDC",
        network: "base",
        defaultCryptoCurrency: "USDC",
        defaultNetwork: "base",
        disableWalletAddressForm: true,
        themeColor: "0052FF",
        hideMenu: true,
      },
    }),
  });

  if (!sessionResponse.ok) {
    throw new Error("Failed to create Transak funding session.");
  }

  const sessionData = await sessionResponse.json();
  return {
    widget_url: sessionData.widgetUrl || null,
    session_id: sessionData.sessionId || null,
  };
}

async function buildQrBundle(address, options = {}) {
  const env = options.env || process.env;
  const includeDataUrl =
    options.includeQrDataUrl === true || boolFromEnv(env.APIOSK_INCLUDE_QR_DATA_URL, false);
  const qrEnabled = boolFromEnv(env.APIOSK_ENABLE_QR, true);
  const transferUri = `ethereum:${address}@8453`;
  const payload = address;
  const bundle = {
    qr_payload: payload,
    transfer_uri: transferUri,
    qr_image_url: qrImageUrl(payload),
  };

  if (!qrEnabled) {
    return bundle;
  }

  try {
    bundle.qr_code_terminal = await QRCode.toString(payload, {
      type: "terminal",
      small: true,
    });
    bundle.qr_code_terminal_format = "ansi";
  } catch {
    // Leave terminal QR unset if rendering fails.
  }

  if (includeDataUrl) {
    try {
      bundle.qr_code_data_url = await QRCode.toDataURL(payload, {
        margin: 1,
        width: 280,
      });
    } catch {
      // Leave data URL unset if rendering fails.
    }
  }

  return bundle;
}

function buildFundingProviders(address, env = process.env) {
  const { apiKey: transakApiKey, secret: transakSecret } = getTransakConfig(env);
  const { apiKey: onramperApiKey, widgetSecret: onramperWidgetSecret } = getOnramperConfig(env);

  return [
    {
      id: "manual",
      label: "Receive on Base",
      description: "Send ETH or USDC on Base directly to this wallet address.",
      available: true,
      kind: "direct",
      address,
      explorer_url: `${BASE_EXPLORER_URL}/address/${address}`,
    },
    {
      id: "transak",
      label: "Transak",
      description: "Direct card or bank checkout for Base USDC.",
      available: Boolean(transakApiKey && transakSecret),
      kind: "direct",
      action_hint: "Call apiosk_configure with section='funding' and funding_provider='transak' to request a checkout URL.",
    },
    {
      id: "onramper",
      label: "Onramper",
      description: "Multi-provider onramp with outsourced KYC.",
      available: Boolean(onramperApiKey && onramperWidgetSecret),
      kind: "aggregator",
      action_hint: "Call apiosk_configure with section='funding' and funding_provider='onramper' to request a checkout URL.",
    },
  ];
}

export async function buildFundingOptions({
  wallet,
  env = process.env,
  fetchImpl = globalThis.fetch,
  fundingProvider = null,
  includeQrDataUrl = false,
} = {}) {
  if (!wallet?.address) {
    return null;
  }

  const address = trimString(wallet.address).toLowerCase();
  const receiveOnBase = {
    title: "Receive on Base",
    description: "This address accepts both ETH and USDC on Base.",
    address,
    network: "Base",
    accepted_assets: ["ETH", "USDC"],
    explorer_url: `${BASE_EXPLORER_URL}/address/${address}`,
    ...await buildQrBundle(address, { env, includeQrDataUrl }),
  };

  const providers = buildFundingProviders(address, env);
  let selectedProvider = null;
  const requestedProvider = trimString(fundingProvider).toLowerCase();

  if (requestedProvider && requestedProvider !== "manual") {
    const provider = providers.find((entry) => entry.id === requestedProvider);
    if (provider) {
      if (!provider.available) {
        selectedProvider = {
          ...provider,
          error: `${provider.label} is not configured in this environment.`,
        };
      } else if (provider.id === "onramper") {
        selectedProvider = {
          ...provider,
          widget_url: buildOnramperWidgetUrl(address, env),
          opens_in: "browser",
        };
      } else if (provider.id === "transak") {
        const session = await createTransakFundingSession(address, env, fetchImpl);
        selectedProvider = {
          ...provider,
          ...session,
          opens_in: "browser",
        };
      }
    }
  } else if (requestedProvider === "manual") {
    selectedProvider = providers.find((entry) => entry.id === "manual") || null;
  }

  return {
    receive_on_base: receiveOnBase,
    providers,
    selected_provider: selectedProvider,
    notes: [
      "Base mainnet only.",
      "Manual funding works even when embedded onramp providers are unavailable.",
      "Use the wallet address or QR code from this section to top up the wallet.",
    ],
  };
}
