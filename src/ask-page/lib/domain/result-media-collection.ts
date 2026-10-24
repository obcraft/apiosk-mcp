import { resultMedia, resultMediaHints, type ResultMedia, type ResultMediaHints } from './result-media'
import { extractResponseLinks } from './link-preview'

/** Read saved data only; never resolve URLs or buy another source response. */
export function collectResultMedia(value: unknown): { items: { media: ResultMedia; key: string; identity: unknown }[]; truncated: boolean } {
  const items: { media: ResultMedia; key: string; identity: unknown }[] = []
  const seen = new Set<unknown>()
  const visited = new WeakSet<object>()
  let remaining = 10_000, truncated = false
  function visit(node: unknown, hints: ResultMediaHints = {}, path = 'result', depth = 0) {
    if (--remaining < 0 || depth > 20) { truncated = true; return }
    if (node == null) return
    const media = resultMedia(node, hints)
    if (media) {
      const identity = media.url ?? media.source ?? node
      if (!seen.has(identity)) { seen.add(identity); items.push({ media, key: path, identity }) }
      return
    }
    if (typeof node === 'string') {
      for (const [index, link] of extractResponseLinks(node).entries()) {
        const attachment = resultMedia(link.url, { name: link.title })
        if (attachment && !seen.has(link.url)) {
          seen.add(link.url)
          items.push({ media: attachment, key: `${path}.link.${index}`, identity: link.url })
        }
      }
      return
    }
    if (node instanceof ArrayBuffer || ArrayBuffer.isView(node) || typeof Blob !== 'undefined' && node instanceof Blob) return
    if (typeof node !== 'object' || visited.has(node)) return
    visited.add(node)
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length && remaining >= 0; index++) visit(node[index], hints, `${path}.${index}`, depth + 1)
      return
    }
    const record = node as Record<string, unknown>
    for (const [key, child] of Object.entries(record)) {
      visit(child, resultMediaHints(record, key), `${path}.${key}`, depth + 1)
      if (remaining < 0) break
    }
  }
  visit(value)
  return { items, truncated }
}
