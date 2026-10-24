import type { PurchaseSource } from './ask-v2-purchase'

/** Group provider identities without merging their endpoint selections or inputs. */
export function groupSourceItems<T extends { source: PurchaseSource }>(items: T[]): { key: string; items: T[] }[] {
  const groups = new Map<string, { key: string; items: T[] }>()
  for (const item of items) {
    const source = item.source
    const key = `${source.origin}:${source.source_slug?.trim().toLowerCase() || source.name.trim().toLowerCase()}`
    const group = groups.get(key)
    if (group) group.items.push(item)
    else groups.set(key, { key, items: [item] })
  }
  return [...groups.values()]
}
