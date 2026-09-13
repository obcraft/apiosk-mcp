// Task-scoped SSE and recovery only read saved state; never authorize spending.
export const V2_CARD_EVENTS = `
let taskEvents=null,eventTask=null,eventUrl=null,eventRecovery=null,eventFailures=0;
function observeTask(data){
 const ref=data.state?.state_ref,url=data.context_view?.events_url;
 const idle=!data.context_view?.worker_active&&['needs_input','succeeded','partial','failed','unsupported'].includes(data.status);
 if(eventTask!==ref){eventFailures=0;if(eventRecovery){clearTimeout(eventRecovery);eventRecovery=null}}
 if(eventTask===ref&&eventUrl===url&&taskEvents&&!idle)return;
 if(taskEvents){taskEvents.close();taskEvents=null}
 if(idle){if(eventRecovery){clearTimeout(eventRecovery);eventRecovery=null}return}
 if(!ref||!url||typeof EventSource==='undefined'||eventRecovery||eventFailures>=3)return;
 let parsed;try{parsed=new URL(url)}catch{return}
 if(!['https://api.apiosk.com','https://apiosk-gateway-v2.fly.dev'].includes(parsed.origin)||parsed.pathname!=='/v2/tasks/'+ref+'/events')return;
 eventTask=ref;eventUrl=url;
 const recover=()=>{
  if(output?.state?.state_ref!==ref||taskEvents!==stream)return;
  stream.close();taskEvents=null;eventFailures++;
  showFeedback('Live updates are unavailable. Checking the saved request…');
  eventRecovery=setTimeout(async()=>{
   eventRecovery=null;if(output?.state?.state_ref!==ref)return;
   const refreshed=await refreshTask(false);
   if(output?.state?.state_ref!==ref)return;
   if(!refreshed||eventFailures>=3)showFeedback('Use Check status to refresh the saved request.');
   if(refreshed)observeTask(output);
  },2000*eventFailures);
 };
 let stream;try{stream=new EventSource(url);taskEvents=stream}catch{showFeedback('Use Check status to refresh the saved request.');return}
 stream.addEventListener('task',event=>{
  if(taskEvents!==stream||output?.state?.state_ref!==ref)return;
  try{
   const next=JSON.parse(event.data);
   if(next.state?.state_ref!==ref||Number(next.state.revision)<Number(output.state.revision))return;
   if(next.context_view?.events_path)next.context_view.events_url=new URL(next.context_view.events_path,parsed.origin).href;
   const documents=[next.context_view,next.result,...(next.context_view?.results||[]),...(next.context_view?.conversation||[]).flatMap(t=>[t.output,t.output?.result,...(t.output?.results||[])])];
   for(const doc of documents){const path=doc?.report?.download_path;if(typeof path==='string'&&path.startsWith('/v2/tasks/'+ref+'/'))doc.report.url=new URL(path,parsed.origin).href}
   acceptResponse(next);
  }catch{recover()}
 });
 stream.onerror=recover;
}
`;
