// A budget refusal is not an expired login. Open the existing settings without
// revoking tokens, pretending to reconnect, or approving/replaying the task.
export const V2_CARD_BUDGET = `
function renderApprovalRecovery(response,data){
 const codes=[response?.error_code,...(response?.errors||[]).map(error=>error.code)];
 if(!codes.some(code=>['approval_per_request_limit','approval_daily_limit'].includes(code)))return;
 const actions=byId('feedback-actions');
 let url=null;try{url=trustedShortcut(new URL('/connections',dataApprovalOrigin()).href,'/connections')}catch{}
 const button=el('button','primary','Set higher limits');button.type='button';
 const help=el('p','meta','Choose your connection, change its per-request and daily limits, and save. Then return here and check status before approving.');
 button.onclick=async()=>{
  if(output!==data){showFeedback('This request was updated. Check status before continuing.','error');return}
  if(!url||!await window.apiosk.openLink(url).catch(()=>false)){
   help.textContent='Open Apiosk > Integrations, choose your connection, set higher spending limits and save. Then return here and check status before approving.';
   window.apiosk.resize();
  }
 };
 actions.append(button,help,el('p','meta','Or reconnect Apiosk in your chatbot and choose higher limits on the connection screen. After reconnecting, ask the question again using the new connection.'));
 window.apiosk.resize();
}
`;
