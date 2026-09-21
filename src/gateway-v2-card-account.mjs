export const V2_ACCOUNT_STYLE = `
.account-links{display:flex;align-items:center;gap:5px;flex:0 0 auto}.account-links button{padding:6px 8px;border:1px solid color-mix(in srgb,CanvasText 10%,transparent);background:Canvas;color:CanvasText;font-size:10px;white-space:nowrap}.account-links button:hover{background:color-mix(in srgb,CanvasText 6%,transparent)}
@media(max-width:480px){.account-links{width:100%}.account-links button{flex:1}}
`;

export const V2_ACCOUNT_MARKUP = `<nav class="account-links hidden" id="account-shortcuts" aria-label="Apiosk account shortcuts"><button type="button" id="balance-shortcut">Balance</button><button type="button" id="history-shortcut">History</button></nav>`;

// Workspace scoping and destinations remain Gateway output, never client input.
// Identity is deliberately not repeated in the embedded request header.
// Links are limited to the App origin that owns the plan approval and to the
// two exact read/manage destinations rendered by this card.
export const V2_CARD_ACCOUNT = `
function dataApprovalOrigin(){try{return new URL(output?.proposal?.approval_url||'https://app.apiosk.com').origin}catch{return 'https://app.apiosk.com'}}
function trustedShortcut(value,path){try{const url=new URL(value),approval=dataApprovalOrigin();return url.protocol==='https:'&&url.pathname===path&&!url.username&&!url.password&&(!approval||url.origin===approval)?url.href:null}catch{return null}}
function renderAccount(data){
 const bar=byId('account-shortcuts'),workspace=data.context_view?.workspace||data.billing?.workspace;
 if(!workspace?.workspace_id||workspace.kind==='personal'){
  for(const id of ['balance-shortcut','history-shortcut']){const button=byId(id);button.classList.add('hidden');button.onclick=null}
  bar.classList.add('hidden');return
 }
 const links=data.context_view?.navigation||{},balance=trustedShortcut(links.balance_url,'/settings/billing'),history=trustedShortcut(links.history_url,'/usage/history');
 for(const [id,url] of [['balance-shortcut',balance],['history-shortcut',history]]){
  const button=byId(id);button.classList.toggle('hidden',!url);
  button.onclick=url?async()=>{if(!await window.apiosk.openLink(url))showFeedback('Open Apiosk to view this account.','error')}:null
 }
 bar.classList.toggle('hidden',!balance&&!history)
}
`;
