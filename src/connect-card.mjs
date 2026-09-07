// "Can this session buy?", answered where the person can act on it.
//
// apiosk_connect already returns the whole answer — connected or not, the
// balance, the per-call and daily limits, and how much of today's allowance is
// left. On a text host a model relays that, and relays it badly: the number it
// leads with is whichever one it found interesting, and the link to fix an
// empty balance arrives as a URL in a paragraph.
//
// The card leads with the fact that decides everything — can this session pay —
// and puts the one action beside it. Signing in, topping up and setting the
// limits all happen in Apiosk, on the buyer's own approval screen: this card
// opens that door and holds no password, token or limit of its own.
//
// ONE BALANCE, NOT A WALLET. What a person tops up and watches go down is a
// ledger balance; the wallet behind it is the treasury's. There is no chain
// address on this card because reporting one here reported 0 for a perfectly
// funded buyer.

import { APIOSK_UI_BRIDGE, APIOSK_UI_STYLE, uiResourceMeta } from "./ui-bridge.mjs";

export const APIO_CONNECT_CARD_URI = "ui://apiosk/connect-card.html";

export const APIO_CONNECT_CARD_META = (() => {
  const meta = uiResourceMeta(
    "Shows whether this session can pay: the Apiosk balance, the per-call and daily limits, how much of today's allowance is left, and a button to connect or top up."
  );
  meta.ui.csp.resourceDomains = ["https://mcp.apiosk.com"];
  meta["openai/widgetCSP"].resource_domains = ["https://mcp.apiosk.com"];
  return meta;
})();

export const APIO_CONNECT_CARD_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${APIOSK_UI_STYLE}
:root{--apiosk:var(--apiosk-accent);--apiosk-soft:var(--apiosk-accent-wash);--good:#36a577;--bad:#d56071}
body{padding:8px}.card{padding:15px;border-radius:18px;box-shadow:0 18px 45px -38px rgba(72,42,145,.62)}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:15px}.apiosk-wordmark{display:block;width:74px;height:24px}.apiosk-wordmark img{display:block;width:74px;height:24px;object-fit:contain;object-position:left center}.state-pill{border:1px solid color-mix(in srgb,CanvasText 12%,transparent);border-radius:999px;padding:5px 8px;font-size:10px;line-height:1;opacity:.72}
.headline{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}.headline h2{font-size:18px}.balance{font-weight:600;font-size:20px;letter-spacing:-.025em;line-height:1.1;white-space:nowrap}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px;background:var(--bad)}.dot[data-payable="true"]{background:var(--good)}
.limits{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:14px}.limit{padding:10px;border-radius:11px;background:color-mix(in srgb,CanvasText 5%,transparent)}.limit span{font-size:9px;opacity:.62}.limit b{display:block;font-size:14px;font-weight:600;letter-spacing:-.02em;margin-top:3px}
.bar{height:4px;border-radius:99px;margin-top:11px;background:color-mix(in srgb,CanvasText 10%,transparent);overflow:hidden}.bar i{display:block;height:100%;background:var(--apiosk)}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:15px}.status{margin-top:10px;min-height:0}.status:empty{display:none}
@media(max-width:480px){.headline{display:block}.balance{margin-top:10px}.limits{grid-template-columns:1fr}.actions button{flex:1}}
</style></head>
<body><main class="card">
<div class="top"><picture class="apiosk-wordmark"><source media="(prefers-color-scheme:dark)" srcset="https://mcp.apiosk.com/brand/wordmark-white-320.png"><img src="https://mcp.apiosk.com/brand/wordmark-black-320.png" alt="Apiosk" width="320" height="103"></picture><span class="state-pill">Connection</span></div>
<div class="headline"><div><h2 id="state"><span id="dot" class="dot"></span>Checking…</h2><div id="message" class="meta"></div></div><div id="balance" class="balance"></div></div>
<div id="bar" class="bar hidden"><i id="fill"></i></div>
<div id="limits" class="limits"></div>
<div class="actions"><button id="primary" class="primary" type="button">Connect Apiosk</button><button id="recheck" class="secondary" type="button">Re-check</button></div>
<div id="status" class="status" role="status" aria-live="polite"></div>
</main>
<script>${APIOSK_UI_BRIDGE}
const byId=id=>document.getElementById(id),state=byId('state'),dot=byId('dot'),message=byId('message'),balance=byId('balance'),
 bar=byId('bar'),fill=byId('fill'),limits=byId('limits'),primary=byId('primary'),recheck=byId('recheck'),status=byId('status');
let current=null,busy=false;
function setStatus(text,kind){status.textContent=text||'';status.className='status '+(kind||'')}
const money=v=>typeof v==='number'&&Number.isFinite(v)?'$'+v.toFixed(2):null;
function limit(label,value){const box=document.createElement('div');box.className='limit';
 const s=document.createElement('span');s.textContent=label;const b=document.createElement('b');b.textContent=value;box.append(s,b);return box}
function render(output){if(!output||typeof output!=='object')return;current=output;
 const payable=output.payable===true,connected=output.status==='connected';
 dot.dataset.payable=String(payable);
 state.replaceChildren(dot,document.createTextNode(connected?(payable?'Ready to pay':'Connected, cannot pay yet'):'Not connected'));
 message.textContent=output.message||'';
 balance.textContent=connected?(money(output.balance_usd)||'$0.00'):'';
 const l=output.limits||{};
 const boxes=[];
 if(l.per_call_usd!=null)boxes.push(limit('Per call',money(l.per_call_usd)||'—'));
 if(l.daily_usd!=null)boxes.push(limit('Daily limit',money(l.daily_usd)||'—'));
 if(l.daily_remaining_usd!=null)boxes.push(limit('Left today',money(l.daily_remaining_usd)||'—'));
 limits.replaceChildren(...boxes);
 if(l.daily_usd>0&&l.daily_remaining_usd!=null){bar.classList.remove('hidden');
  fill.style.width=Math.max(0,Math.min(100,(l.daily_remaining_usd/l.daily_usd)*100))+'%'}
 else bar.classList.add('hidden');
 primary.textContent=connected?(payable?'Manage in Apiosk':'Top up in Apiosk'):'Connect Apiosk';
 primary.className=payable?'secondary':'primary';
 setStatus(payable?'':'Connect or top up before approving a paid source.');
 window.apiosk.resize()}
primary.addEventListener('click',async()=>{const url=current&&current.connect_url;if(!url)return;
 const opened=await window.apiosk.openLink(url);
 setStatus(opened?'Opened Apiosk. Come back and press re-check when you are done.':'Open '+url+' to finish this.',opened?'ok':'error')});
recheck.addEventListener('click',async()=>{if(busy)return;busy=true;recheck.disabled=true;setStatus('Checking…');
 try{
  if(window.apiosk.can.callTool){render(await window.apiosk.callTool('apiosk_connect',{}));setStatus('')}
  else if(await window.apiosk.say('Check my Apiosk connection again with apiosk_connect.'))setStatus('Asked.','ok');
  else setStatus('This client cannot re-check from the card.','error')}
 catch(error){setStatus((error&&error.message)||'The check failed.','error')}
 finally{busy=false;recheck.disabled=false}});
window.apiosk.onData(render);
</script></body></html>`;
