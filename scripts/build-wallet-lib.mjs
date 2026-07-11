// Build the self-hosted browser bundles the /authorize page uses:
//   - wallet-accounts.mjs        Create-wallet flow (generate a BIP-39 phrase +
//                                derive the account + sign the sign-in message,
//                                all in the user's tab).
//   - walletconnect-provider.mjs WalletConnect sign-in (EthereumProvider + its
//                                QR pairing modal).
//
// Self-hosted on purpose: the page must not depend on a third-party CDN
// (esm.sh) at sign-in time — some embedded browsers (e.g. the ChatGPT iOS
// in-app browser) block cross-origin dynamic module imports outright, which
// surfaces as "Importing a module script failed.", and a CDN outage would
// take sign-in down with it. The outputs are committed (src/assets/*.mjs)
// because the Docker image installs with --omit=dev and never runs a build.
//
// Regenerate after a viem or @walletconnect upgrade:
//   node scripts/build-wallet-lib.mjs

import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const assetsDir = path.join(root, "src", "assets");

await mkdir(assetsDir, { recursive: true });

const shared = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  logLevel: "info",
  define: {
    "process.env.NODE_ENV": '"production"',
    global: "globalThis",
  },
};

const builds = [
  {
    stdin: {
      contents:
        'export { english, generateMnemonic, mnemonicToAccount } from "viem/accounts";\n',
      resolveDir: root,
      sourcefile: "wallet-accounts-entry.mjs",
    },
    outfile: path.join(assetsDir, "wallet-accounts.mjs"),
  },
  {
    stdin: {
      contents:
        'export { EthereumProvider } from "@walletconnect/ethereum-provider";\n',
      resolveDir: root,
      sourcefile: "walletconnect-provider-entry.mjs",
    },
    outfile: path.join(assetsDir, "walletconnect-provider.mjs"),
    // The provider lazily imports its QR modal; keep everything in one file so
    // the page needs exactly one same-origin fetch.
    splitting: false,
  },
];

for (const options of builds) {
  const result = await build({ ...shared, ...options });
  if (result.errors.length) {
    process.exit(1);
  }
}
