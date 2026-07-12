export const SETTLEMENT_DISCLOSURE_PATH = "/security/settlement-contract";
export const SETTLEMENT_CONTRACT_ADDRESS = "0x512c770ef7b651298cbfa2ab865a81c12f0c703d";
export const BASE_USDC_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

export function createSettlementDisclosurePage() {
  const explorerUrl = `https://base.blockscout.com/address/${SETTLEMENT_CONTRACT_ADDRESS}`;
  const sourceUrl = `${explorerUrl}?tab=contract`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <title>Settlement contract security · Apiosk</title>
  <style>:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:light dark;--bg:#f8f9fb;--card:#fff;--fg:#20212a;--muted:#666371;--border:#e4e1ea;--accent:#6b38d4}@media(prefers-color-scheme:dark){:root{--bg:#0d0f13;--card:#15171d;--fg:#ecebf2;--muted:#aaa6b4;--border:#2b2e38;--accent:#a78bfa}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg)}main{width:min(760px,calc(100% - 32px));margin:48px auto;padding:32px;background:var(--card);border:1px solid var(--border);border-radius:18px}h1{margin-top:0;font-size:30px}h2{margin-top:30px;font-size:20px}p,li{line-height:1.6;color:var(--muted)}code{overflow-wrap:anywhere;color:var(--fg)}a{color:var(--accent)}.facts{display:grid;grid-template-columns:max-content 1fr;gap:10px 18px;padding:18px;border:1px solid var(--border);border-radius:12px}.facts dt{font-weight:650}.facts dd{margin:0;color:var(--muted)}@media(max-width:600px){main{margin:16px auto;padding:22px}.facts{grid-template-columns:1fr;gap:4px}.facts dd{margin-bottom:8px}}</style></head><body><main>
    <p><a href="https://apiosk.com">Apiosk</a> / Security</p>
    <h1>USDC settlement contract</h1>
    <p>This page documents the contract used when a connected wallet authorizes pay-per-call API payments through Apiosk.</p>
    <dl class="facts"><dt>Network</dt><dd>Base mainnet (chain ID 8453)</dd><dt>Contract</dt><dd><code>${SETTLEMENT_CONTRACT_ADDRESS}</code></dd><dt>Token</dt><dd>Native USDC · <code>${BASE_USDC_ADDRESS}</code></dd><dt>Current platform fee</dt><dd>2% (200 basis points), readable on-chain via <code>platformFeeBps()</code></dd><dt>Upgradeability</dt><dd>Not a proxy; deployed bytecode cannot be upgraded</dd></dl>
    <h2>Fee history disclosure</h2>
    <p>The verified deployment source initializes the platform fee at 10% (1,000 basis points). The contract owner subsequently changed it to 2% using the public <code>setPlatformFee</code> function. The current value is stored on-chain and is authoritative. The verified source remains the immutable historical source of the deployed bytecode and therefore still shows its original constructor-era default.</p>
    <h2>What an approval permits</h2>
    <p>The authorization transaction calls USDC <code>approve(address,uint256)</code> with this settlement contract as spender and the exact spending-cap amount selected in the authorization screen. It is not an unlimited approval and it does not grant access to ETH or other tokens. USDC allowance decreases as payments settle.</p>
    <p>Only the contract owner or an address enabled in the public <code>operators</code> mapping can call settlement. The owner can change operators, the platform wallet, and the fee (capped in the deployed contract at 50%). Apiosk's off-chain connection limits provide additional per-request and daily controls.</p>
    <h2>Independent verification</h2>
    <p><a href="${explorerUrl}">View the address and reputation on Base Blockscout</a><br /><a href="${sourceUrl}">Review the verified source and contract interface</a></p>
    <p>Security reports: <a href="mailto:security@apiosk.com">security@apiosk.com</a></p>
  </main></body></html>`;
}
