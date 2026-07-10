// Build the self-hosted browser bundle the /authorize page uses for its
// Create-wallet flow (generate a BIP-39 phrase + derive the account + sign the
// sign-in message, all in the user's tab).
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
const outfile = path.join(root, "src", "assets", "wallet-accounts.mjs");

await mkdir(path.dirname(outfile), { recursive: true });

const result = await build({
  stdin: {
    contents:
      'export { english, generateMnemonic, mnemonicToAccount } from "viem/accounts";\n',
    resolveDir: root,
    sourcefile: "wallet-accounts-entry.mjs",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  outfile,
  logLevel: "info",
  define: { "process.env.NODE_ENV": '"production"' },
});

if (result.errors.length) {
  process.exit(1);
}
