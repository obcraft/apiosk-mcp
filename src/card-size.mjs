// Current cards measure their content rather than the iframe viewport. Keep
// the recorded MCP1 bridge untouched, including its transport implementation.
const ORIGINAL_RESIZE = `resize(){const width=Math.ceil(document.documentElement.scrollWidth),height=Math.ceil(document.documentElement.scrollHeight);
  if(window.openai&&window.openai.notifyIntrinsicHeight){try{window.openai.notifyIntrinsicHeight(height)}catch(e){}}
  if(mcp)send({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{width,height}})}`;

const INTRINSIC_RESIZE = `resize(){
  const root=document.documentElement,body=document.body,box=body?.getBoundingClientRect?.(),style=body?window.getComputedStyle?.(body):null;
  const width=Math.ceil(root.clientWidth||root.scrollWidth||0),height=Math.ceil(Math.max(0,(box?.height??root.scrollHeight)+(parseFloat(style?.marginTop)||0)+(parseFloat(style?.marginBottom)||0)));
  const previous=api.resize.previous||(api.resize.previous={});
  if(window.openai&&window.openai.notifyIntrinsicHeight&&previous.openai!==height){try{window.openai.notifyIntrinsicHeight(height);previous.openai=height}catch(e){}}
  if(mcp&&(previous.width!==width||previous.height!==height)){previous.width=width;previous.height=height;send({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{width,height}})}
 }`;

export function withIntrinsicCardSize(html) {
  const replacements = [
    [ORIGINAL_RESIZE, INTRINSIC_RESIZE],
    ["new ResizeObserver(()=>api.resize()).observe(document.documentElement)", "new ResizeObserver(()=>api.resize()).observe(document.body||document.documentElement)"],
    ["send({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}});", "send({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}});api.resize();"],
  ];
  for (const [before, after] of replacements) {
    if (!html.includes(before)) throw new Error('The current card resize adapter no longer matches the recorded bridge.');
    html = html.replace(before, after);
  }
  return html;
}
