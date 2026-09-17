export const V2_ACCOUNT_STYLE = `
.account-bar{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:10px 13px;border-bottom:1px solid color-mix(in srgb,CanvasText 10%,transparent);background:color-mix(in srgb,CanvasText 2.5%,transparent)}.account-copy{min-width:0}.account-org{display:block;font-size:9px;line-height:1.2;opacity:.58;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.account-name{display:block;margin-top:2px;font-size:12px;font-weight:600;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.account-links{display:flex;align-items:center;gap:5px;flex:0 0 auto}.account-links button{padding:6px 8px;border:1px solid color-mix(in srgb,CanvasText 10%,transparent);background:Canvas;color:CanvasText;font-size:10px}.account-links button:hover{background:color-mix(in srgb,CanvasText 6%,transparent)}
@media(max-width:480px){.account-bar{align-items:flex-start;flex-direction:column;gap:8px}.account-links{width:100%}.account-links button{flex:1}}
`;

export const V2_ACCOUNT_MARKUP = `<div class="account-bar hidden" id="account-bar"><div class="account-copy"><span class="account-org" id="account-org"></span><strong class="account-name" id="account-name"></strong></div><nav class="account-links" aria-label="Apiosk account shortcuts"><button type="button" id="balance-shortcut">Balance</button><button type="button" id="history-shortcut">History</button></nav></div>`;

// Account identity and destinations are Gateway output, never client input.
// Links are limited to the App origin that owns the plan approval and to the
// two exact read/manage destinations rendered by this card.
export const V2_CARD_ACCOUNT = `
function dataApprovalOrigin(){try{return new URL(output?.proposal?.approval_url||'https://app.apiosk.com').origin}catch{return 'https://app.apiosk.com'}}
function trustedShortcut(value,path){try{const url=new URL(value),approval=dataApprovalOrigin();return url.protocol==='https:'&&url.pathname===path&&!url.username&&!url.password&&(!approval||url.origin===approval)?url.href:null}catch{return null}}
function renderAccount(data){
 const bar=byId('account-bar'),workspace=data.context_view?.workspace||data.billing?.workspace;
 if(!workspace?.workspace_id||workspace.kind==='personal'){
  for(const id of ['balance-shortcut','history-shortcut']){const button=byId(id);button.classList.add('hidden');button.onclick=null}
  bar.classList.add('hidden');return
 }
 byId('account-name').textContent=workspace.name||'Shared workspace';
 byId('account-org').textContent=workspace.organisation_name||'Organisation workspace';
 const links=data.context_view?.navigation||{},balance=trustedShortcut(links.balance_url,'/settings/billing'),history=trustedShortcut(links.history_url,'/usage/history');
 for(const [id,url] of [['balance-shortcut',balance],['history-shortcut',history]]){
  const button=byId(id);button.classList.toggle('hidden',!url);
  button.onclick=url?async()=>{if(!await window.apiosk.openLink(url))showFeedback('Open Apiosk to view this account.','error')}:null
 }
 bar.classList.remove('hidden')
}
`;
