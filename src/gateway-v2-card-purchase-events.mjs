// External purchases and mixed selections run in the backend. Poll only their
// saved status; the timer never prepares, approves, executes, or prompts a model.
export const V2_CARD_PURCHASE_EVENTS = `
let savedPurchaseRead=null,savedPurchaseWatcherStopped=false;
function runningSavedPurchases(data){
 if(data?.view==='external_purchase')return data.status==='running'?[{kind:'external',ref:data.purchase_id,before:data}]:[];
 if(data?.view!=='source_basket')return [];
 return (data.entries||[]).filter(entry=>entry.response&&(entry.response.status==='running'||entry.response.context_view?.worker_active===true||entry.uncertain)).map(entry=>({kind:entry.kind,ref:basketRef(entry),before:entry.response,entry})).filter(item=>item.ref);
}
function observeSavedPurchases(data){
 if(savedPurchaseWatcherStopped||output!==data||pollTimer||!window.apiosk.can.callTool||!runningSavedPurchases(data).length)return;
 pollTimer=setTimeout(()=>{
  pollTimer=null;if(savedPurchaseWatcherStopped||output!==data)return;
  if(busy||savedPurchaseRead?.data===data){observeSavedPurchases(data);return}
  void refreshRunningPurchases(data);
 },2000);
}
async function refreshRunningPurchases(data){
 if(savedPurchaseWatcherStopped||output!==data)return;
 const read={data},items=runningSavedPurchases(data);savedPurchaseRead=read;
 try{
  const results=await Promise.all(items.map(async item=>{
   try{return {...item,next:await window.apiosk.callTool(item.kind==='external'?'apiosk_external':'apiosk_status',item.kind==='external'?{action:'status',purchase_id:item.ref}:{task_ref:item.ref})}}
   catch(error){return {...item,error}}
  }));
  if(savedPurchaseWatcherStopped||output!==data||busy)return;
  let failed=false,changed=false;
  for(const item of results){
   // A manual refresh may have advanced this same basket while polling waited.
   if(item.entry&&item.entry.response!==item.before)continue;
   if(item.error){failed=true;continue}
   try{
    if(item.entry){
     if(item.kind==='local'&&Number(item.next?.state?.revision)<Number(item.before.state?.revision))continue;
     basketAcceptEntry(item.entry,item.next);changed=true;
    }else{acceptExternalResponse(item.next,item.ref);changed=true}
   }catch{failed=true}
  }
  if(data.view==='source_basket'&&changed){render(data);void window.apiosk.context(data).catch(()=>{})}
  if(failed)showFeedback('Live updates are temporarily unavailable. Checking the saved status again shortly.');
 }finally{
  if(savedPurchaseRead===read)savedPurchaseRead=null;
  if(output===data)observeSavedPurchases(data);
 }
}
function stopSavedPurchaseWatcher(){savedPurchaseWatcherStopped=true;savedPurchaseRead=null;if(pollTimer){clearTimeout(pollTimer);pollTimer=null}}
window.addEventListener('pagehide',stopSavedPurchaseWatcher);
window.addEventListener('beforeunload',stopSavedPurchaseWatcher);
`;
