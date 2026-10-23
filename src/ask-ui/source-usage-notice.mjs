// Source access terms are plain attribution, never executable provider content.
export function sourceUsageNotices(sources) {
  const seen = new Set(), notices = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    const value = source?.usage_notice;
    if (typeof value?.text !== 'string' || !value.text.trim() || value.text.length > 2400) continue;
    const notice = { text: value.text.trim() };
    try {
      const url = new URL(value.url);
      if (url.protocol === 'https:' && !url.username && !url.password) {
        notice.url = url.href;
        notice.label = typeof value.label === 'string' && value.label.trim() ? value.label.slice(0,120) : 'Original source';
      }
    } catch { /* A malformed optional link never hides the source notice. */ }
    const key = JSON.stringify(notice);
    if (!seen.has(key)) { seen.add(key); notices.push(notice); }
  }
  return notices;
}

export const V2_SOURCE_USAGE_NOTICE = `
${sourceUsageNotices.toString()}
function appendSourceUsageNotices(target,sources){
 for(const notice of sourceUsageNotices(sources)){
  const note=el('div','source-usage-notice');note.append(el('p','meta',notice.text));
  if(notice.url){const link=el('button','text-action',notice.label);link.onclick=()=>window.apiosk.openLink(notice.url);note.append(link)}
  target.append(note);
 }
}
`;
