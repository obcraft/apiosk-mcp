// Build the self-hosted browser bundles the /authorize page uses for its
// Create-wallet and WalletConnect flows.
//
// Self-hosted on purpose: the page must not depend on a third-party CDN
// (esm.sh) at sign-in time — some embedded browsers block cross-origin dynamic
// module imports outright, and a CDN outage would take wallet creation down
// with it. The output is committed (src/assets/wallet-accounts.mjs) because
// the Docker image installs with --omit=dev and never runs a build.
//
// Regenerate after a viem upgrade:  node scripts/build-wallet-lib.mjs

import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const assetsDir = path.join(root, "src", "assets");
await mkdir(assetsDir, { recursive: true });

const bundles = [
  {
    sourcefile: "wallet-accounts-entry.mjs",
    contents:
      'export { english, generateMnemonic, mnemonicToAccount } from "viem/accounts";\n',
    outfile: path.join(assetsDir, "wallet-accounts.mjs"),
  },
  {
    sourcefile: "walletconnect-provider-entry.mjs",
    contents:
      'export { EthereumProvider } from "@walletconnect/ethereum-provider";\n',
    outfile: path.join(assetsDir, "walletconnect-provider.mjs"),
  },
];

for (const bundle of bundles) {
  const result = await build({
    stdin: {
      contents: bundle.contents,
      resolveDir: root,
      sourcefile: bundle.sourcefile,
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2020"],
    minify: true,
    outfile: bundle.outfile,
    logLevel: "info",
    define: { "process.env.NODE_ENV": '"production"' },
  });

  if (result.errors.length) process.exit(1);
}
