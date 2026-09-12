// Task-scoped SSE is read-only. It cannot start or authorize a purchase.
export const V2_CARD_EVENTS = `
let taskEvents=null,eventTask=null,eventUrl=null;
function observeTask(data){
 const ref=data.state?.state_ref,url=data.context_view?.events_url;
 const terminal=['succeeded','partial','failed','unsupported'].includes(data.status)&&!data.context_view?.worker_active;
 if(eventTask===ref&&taskEvents&&!terminal)return;
 if(taskEvents){taskEvents.close();taskEvents=null}
 if(terminal||!ref||!url||typeof EventSource==='undefined')return;
 let parsed;try{parsed=new URL(url)}catch{return}
 if(!['https://api.apiosk.com','https://apiosk-gateway-v2.fly.dev'].includes(parsed.origin)||parsed.pathname!=='/v2/tasks/'+ref+'/events')return;
 eventTask=ref;eventUrl=url;const stream=new EventSource(url);taskEvents=stream;
 stream.addEventListener('task',event=>{
  try{
   const next=JSON.parse(event.data);
   if(output?.state?.state_ref!==ref||next.state?.state_ref!==ref||Number(next.state.revision)<Number(output.state.revision))return;
   next.context_view.events_url=new URL(next.context_view.events_path,parsed.origin).href;
   const documents=[next.context_view,next.result,...(next.context_view.results||[]),...(next.context_view.conversation||[]).flatMap(t=>[t.output,t.output?.result,...(t.output?.results||[])])];
   for(const doc of documents){const path=doc?.report?.download_path;if(typeof path==='string'&&path.startsWith('/v2/tasks/'+ref+'/'))doc.report.url=new URL(path,parsed.origin).href}
   acceptResponse(next);
  }catch{stream.close();taskEvents=null;showFeedback('Live updates were interrupted. Check status to recover your saved request.','error')}
 });
 stream.onerror=()=>{stream.close();if(taskEvents===stream)taskEvents=null;showFeedback('Live updates were interrupted. Your request continues on the server. Use Check status to reconnect.','error')};
}
`;
