export const SETTLEMENT_DISCLOSURE_PATH = "/security/settlement-contract";

export function createSettlementDisclosurePage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <title>Payment authorization · Apiosk</title>
  <style>:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:light dark;--bg:#f8f9fb;--card:#fff;--fg:#20212a;--muted:#666371;--border:#e4e1ea;--accent:#6b38d4}@media(prefers-color-scheme:dark){:root{--bg:#0d0f13;--card:#15171d;--fg:#ecebf2;--muted:#aaa6b4;--border:#2b2e38;--accent:#a78bfa}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg)}main{width:min(760px,calc(100% - 32px));margin:48px auto;padding:32px;background:var(--card);border:1px solid var(--border);border-radius:18px}h1{margin-top:0;font-size:30px}h2{margin-top:30px;font-size:20px}p,li{line-height:1.6;color:var(--muted)}code{overflow-wrap:anywhere;color:var(--fg)}a{color:var(--accent)}.facts{display:grid;grid-template-columns:max-content 1fr;gap:10px 18px;padding:18px;border:1px solid var(--border);border-radius:12px}.facts dt{font-weight:650}.facts dd{margin:0;color:var(--muted)}@media(max-width:600px){main{margin:16px auto;padding:22px}.facts{grid-template-columns:1fr;gap:4px}.facts dd{margin-bottom:8px}}</style></head><body><main>
    <p><a href="https://apiosk.com">Apiosk</a> / Security</p>
    <h1>Payment authorization</h1>
    <p>Apiosk uses your account or workspace balance for approved API requests. The former smart-contract payment flow is retired; this page remains available for existing links.</p>
    <h2>What an approval permits</h2>
    <p>Each plan shows one total price ceiling. Approval authorizes that plan within your connected account's spending limits, and the Gateway executes the approved source calls.</p>
    <p>This flow does not require a wallet transaction or a token allowance. A chat message or tool permission does not approve a purchase. A previously configured automatic-approval rule can authorize requests within its limits.</p>
    <h2>Saved results and spending controls</h2>
    <p>Opening a card or retrieving a saved result does not buy the same work again. Manage your balance, connections and spending limits in the <a href="https://app.apiosk.com">Apiosk app</a>.</p>
    <p>Security reports: <a href="mailto:security@apiosk.com">security@apiosk.com</a></p>
  </main></body></html>`;
}
