import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";

import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

const STORE_VERSION = 1;

function trimString(value) {
  return String(value || "").trim();
}

function defaultApioskDir(env = process.env) {
  const configured = trimString(env.APIOSK_HOME);
  if (configured) return configured;

  const home = trimString(env.HOME) || os.homedir();
  return path.join(home, ".apiosk");
}

function createPaths(env = process.env) {
  const apioskDir = defaultApioskDir(env);
  return {
    apioskDir,
    storeFile: trimString(env.APIOSK_MCP_WALLET_STORE) || path.join(apioskDir, "mcp-wallets.json"),
    activeWalletJsonFile: path.join(apioskDir, "wallet.json"),
    activeWalletTextFile: path.join(apioskDir, "wallet.txt"),
    secretExportDir: path.join(apioskDir, "exports"),
  };
}

function defaultStore() {
  return {
    version: STORE_VERSION,
    active_wallet_id: null,
    wallets: [],
  };
}

function normalizePrivateKey(secret) {
  const trimmed = trimString(secret);
  if (!trimmed) {
    throw new Error("Wallet secret is required.");
  }

  const normalized = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("Private key must be 32 bytes of hex.");
  }

  return normalized.toLowerCase();
}

function normalizeMnemonic(secret) {
  const normalized = trimString(secret)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");

  if (!normalized) {
    throw new Error("Recovery phrase is required.");
  }

  return normalized;
}

function sortWallets(wallets = [], activeWalletId = null) {
  return [...wallets].sort((left, right) => {
    if (left.id === activeWalletId && right.id !== activeWalletId) return -1;
    if (right.id === activeWalletId && left.id !== activeWalletId) return 1;

    return String(right.updated_at || right.created_at || "").localeCompare(
      String(left.updated_at || left.created_at || "")
    );
  });
}

function summarizeWallet(wallet, activeWalletId = null) {
  return {
    id: wallet.id,
    label: wallet.label,
    address: wallet.address,
    active: wallet.id === activeWalletId,
    source: wallet.source,
    created_at: wallet.created_at,
    updated_at: wallet.updated_at,
  };
}

async function safeChmod(filePath, mode) {
  try {
    await chmod(filePath, mode);
  } catch {
    // Best effort only; not all environments support chmod.
  }
}

async function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  await mkdir(dir, { recursive: true });
  await writeFile(tempFile, JSON.stringify(value, null, 2), "utf8");
  await safeChmod(tempFile, 0o600);
  await rename(tempFile, filePath);
  await safeChmod(filePath, 0o600);
}

async function writeTextAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  await mkdir(dir, { recursive: true });
  await writeFile(tempFile, value, "utf8");
  await safeChmod(tempFile, 0o600);
  await rename(tempFile, filePath);
  await safeChmod(filePath, 0o600);
}

async function removeFileQuietly(filePath) {
  try {
    await rm(filePath, { force: true });
  } catch {
    // Ignore cleanup failures.
  }
}

export function createLocalWalletStore(env = process.env) {
  const paths = createPaths(env);

  async function ensureBaseDir() {
    await mkdir(paths.apioskDir, { recursive: true });
    await safeChmod(paths.apioskDir, 0o700);
  }

  async function readStore() {
    try {
      const raw = await readFile(paths.storeFile, "utf8");
      const parsed = JSON.parse(raw);
      const wallets = Array.isArray(parsed?.wallets) ? parsed.wallets : [];

      return {
        version: STORE_VERSION,
        active_wallet_id:
          typeof parsed?.active_wallet_id === "string" && parsed.active_wallet_id.trim()
            ? parsed.active_wallet_id
            : null,
        wallets: wallets.map((wallet) => ({
          id: trimString(wallet.id) || randomUUID(),
          label: trimString(wallet.label) || "Wallet",
          address: trimString(wallet.address).toLowerCase(),
          private_key: normalizePrivateKey(wallet.private_key),
          source: trimString(wallet.source) || "generated",
          created_at: trimString(wallet.created_at) || new Date().toISOString(),
          updated_at: trimString(wallet.updated_at) || new Date().toISOString(),
        })),
      };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return defaultStore();
      }

      throw new Error(
        `Could not read the local Apiosk wallet store: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  async function writeStore(store) {
    await ensureBaseDir();
    await writeJsonAtomic(paths.storeFile, store);
  }

  async function syncActiveWalletFiles(store) {
    const activeWallet = store.wallets.find((wallet) => wallet.id === store.active_wallet_id) || null;

    if (!activeWallet) {
      await Promise.all([
        removeFileQuietly(paths.activeWalletJsonFile),
        removeFileQuietly(paths.activeWalletTextFile),
      ]);
      return;
    }

    await ensureBaseDir();
    await writeJsonAtomic(paths.activeWalletJsonFile, {
      id: activeWallet.id,
      label: activeWallet.label,
      address: activeWallet.address,
      private_key: activeWallet.private_key,
      source: activeWallet.source,
      created_at: activeWallet.created_at,
      updated_at: activeWallet.updated_at,
    });
    await writeTextAtomic(paths.activeWalletTextFile, `${activeWallet.address}\n`);
  }

  async function saveStore(store) {
    await writeStore(store);
    await syncActiveWalletFiles(store);
    return store;
  }

  async function getStore() {
    return readStore();
  }

  async function getWalletOrThrow(walletId) {
    const store = await getStore();
    const wallet = store.wallets.find((candidate) => candidate.id === walletId);

    if (!wallet) {
      throw new Error(`Unknown wallet id: ${walletId}`);
    }

    return { store, wallet };
  }

  async function listWallets() {
    const store = await getStore();
    return {
      active_wallet_id: store.active_wallet_id,
      store_file: paths.storeFile,
      wallet_json_file: paths.activeWalletJsonFile,
      wallet_txt_file: paths.activeWalletTextFile,
      wallets: sortWallets(store.wallets, store.active_wallet_id).map((wallet) =>
        summarizeWallet(wallet, store.active_wallet_id)
      ),
    };
  }

  async function resolveActiveWallet() {
    const store = await getStore();
    const wallet = store.wallets.find((candidate) => candidate.id === store.active_wallet_id) || null;
    return wallet ? summarizeWallet(wallet, store.active_wallet_id) : null;
  }

  async function getWalletRecord(walletId) {
    const { store, wallet } = await getWalletOrThrow(walletId);
    return summarizeWallet(wallet, store.active_wallet_id);
  }

  async function getWalletPrivateData(walletId) {
    const { store, wallet } = await getWalletOrThrow(walletId);
    return {
      wallet: summarizeWallet(wallet, store.active_wallet_id),
      private_key: wallet.private_key,
    };
  }

  async function createWallet({
    label,
    mode = "create",
    secret = "",
    set_active = true,
  } = {}) {
    const cleanLabel = trimString(label);
    if (!cleanLabel) {
      throw new Error("Wallet label is required.");
    }
    if (cleanLabel.length > 64) {
      throw new Error("Wallet label must be 64 characters or less.");
    }

    let account;
    let privateKey;
    let source = "generated";
    if (mode === "import_private_key") {
      privateKey = normalizePrivateKey(secret);
      account = privateKeyToAccount(privateKey);
      source = "imported_private_key";
    } else if (mode === "import_phrase") {
      account = mnemonicToAccount(normalizeMnemonic(secret));
      privateKey = `0x${Buffer.from(account.getHdKey().privateKey).toString("hex")}`;
      source = "imported_phrase";
    } else {
      privateKey = generatePrivateKey();
      account = privateKeyToAccount(privateKey);
    }

    const store = await getStore();
    const address = account.address.toLowerCase();
    const duplicate = store.wallets.find((wallet) => wallet.address === address);

    if (duplicate) {
      throw new Error(`Wallet ${address} is already in the local store.`);
    }

    const now = new Date().toISOString();
    const wallet = {
      id: randomUUID(),
      label: cleanLabel,
      address,
      private_key: normalizePrivateKey(privateKey),
      source,
      created_at: now,
      updated_at: now,
    };

    store.wallets.unshift(wallet);
    if (set_active !== false || !store.active_wallet_id) {
      store.active_wallet_id = wallet.id;
    }

    await saveStore(store);

    return {
      wallet: summarizeWallet(wallet, store.active_wallet_id),
      active_wallet_id: store.active_wallet_id,
      store_file: paths.storeFile,
      wallet_json_file: paths.activeWalletJsonFile,
      wallet_txt_file: paths.activeWalletTextFile,
      next_steps: [
        "Use apiosk_execute or any API-specific Apiosk tool to make paid calls with the active wallet.",
        "Use apiosk_publish_api to publish an API with the same active wallet.",
      ],
    };
  }

  async function selectWallet(walletId) {
    const { store, wallet } = await getWalletOrThrow(walletId);
    store.active_wallet_id = wallet.id;
    wallet.updated_at = new Date().toISOString();
    await saveStore(store);

    return {
      wallet: summarizeWallet(wallet, store.active_wallet_id),
      wallet_json_file: paths.activeWalletJsonFile,
      wallet_txt_file: paths.activeWalletTextFile,
    };
  }

  async function updateWallet(walletId, updates = {}) {
    const { store, wallet } = await getWalletOrThrow(walletId);
    const nextLabel =
      updates.label === undefined ? wallet.label : trimString(updates.label);

    if (!nextLabel) {
      throw new Error("Wallet label cannot be empty.");
    }
    if (nextLabel.length > 64) {
      throw new Error("Wallet label must be 64 characters or less.");
    }

    wallet.label = nextLabel;
    wallet.updated_at = new Date().toISOString();

    if (updates.set_active === true) {
      store.active_wallet_id = wallet.id;
    }

    await saveStore(store);
    return {
      wallet: summarizeWallet(wallet, store.active_wallet_id),
    };
  }

  async function deleteWallet(walletId) {
    const store = await getStore();
    const existingIndex = store.wallets.findIndex((wallet) => wallet.id === walletId);

    if (existingIndex === -1) {
      throw new Error(`Unknown wallet id: ${walletId}`);
    }

    const [removed] = store.wallets.splice(existingIndex, 1);
    if (store.active_wallet_id === removed.id) {
      store.active_wallet_id = store.wallets[0]?.id || null;
    }

    await saveStore(store);
    return {
      deleted_wallet_id: removed.id,
      deleted_wallet_address: removed.address,
      active_wallet_id: store.active_wallet_id,
    };
  }

  async function revealSecret(walletId) {
    const { wallet, private_key } = await getWalletPrivateData(walletId);
    return {
      wallet,
      private_key,
      warning: "This is the raw private key. Only reveal it when the user explicitly asks for it.",
    };
  }

  async function saveSecret(walletId, options = {}) {
    const { wallet, private_key } = await getWalletPrivateData(walletId);
    const format = trimString(options.format || "json").toLowerCase();
    if (!["json", "txt"].includes(format)) {
      throw new Error("Secret export format must be either 'json' or 'txt'.");
    }

    const explicitPath = trimString(options.path);
    const defaultFilename = `${wallet.label
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || wallet.id}.${format}`;
    const outputPath = explicitPath || path.join(paths.secretExportDir, defaultFilename);

    await mkdir(path.dirname(outputPath), { recursive: true });
    if (format === "json") {
      await writeJsonAtomic(outputPath, {
        id: wallet.id,
        label: wallet.label,
        address: wallet.address,
        private_key,
        source: wallet.source,
        exported_at: new Date().toISOString(),
      });
    } else {
      await writeTextAtomic(outputPath, `${private_key}\n`);
    }

    return {
      wallet,
      saved_to: outputPath,
      format,
      warning: "The exported file contains the raw private key. Keep it private.",
    };
  }

  async function resolveSigningWallet(walletId = null) {
    const targetWalletId = trimString(walletId);
    if (targetWalletId) {
      const { wallet, private_key } = await getWalletPrivateData(targetWalletId);
      return {
        id: wallet.id,
        label: wallet.label,
        address: wallet.address,
        private_key,
        source: "local_store",
      };
    }

    const store = await getStore();
    const activeWallet = store.wallets.find((wallet) => wallet.id === store.active_wallet_id);
    if (!activeWallet) {
      return null;
    }

    return {
      id: activeWallet.id,
      label: activeWallet.label,
      address: activeWallet.address,
      private_key: activeWallet.private_key,
      source: "local_store",
    };
  }

  return {
    paths,
    listWallets,
    resolveActiveWallet,
    resolveSigningWallet,
    getWalletRecord,
    createWallet,
    selectWallet,
    updateWallet,
    deleteWallet,
    revealSecret,
    saveSecret,
  };
}
