import * as React from 'react'
import { createContext, useContext } from 'react'
import { readFields, type InputField, type SchemaNode } from './lib/domain/inputs'

/** The browser-specific services supplied by the MCP host. No purchases here. */
export const MoneyContext = createContext({ currency: 'USD', rate: 1, ready: true })
export const useMoney = () => useContext(MoneyContext)
export type PurchaseSource = Record<string, any>
export type AskSourceItem = { key: string; source: PurchaseSource }
export type AskTurnSelection = { items: AskSourceItem[]; open: boolean }
export const stickyBar = 'ask-sticky-bar flex w-full items-center justify-between gap-3 rounded-xl border border-border-2 bg-surface px-3 py-3 sm:px-4'

export function safeSourceUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined
  } catch { return undefined }
}

export function purchaseInputKey(source: PurchaseSource): string {
  const values = source.endpoint?.input_values
  const stable = (value: any): any => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value
  return values === undefined ? '' : JSON.stringify(stable(values))
}

export function sourceRef(source: PurchaseSource) {
  if (source.origin === 'apiosk') {
    const available = source.availability === 'supported' || source.availability === 'unverified'
    return source.endpoint_id && available ? { kind: 'endpoint', endpoint_id: source.endpoint_id, ...(source.capability ? { capability: source.capability } : {}) } : null
  }
  try {
    const url = new URL(source.url ?? '')
    if (url.protocol !== 'https:' || url.username || url.password) return null
    return { kind: 'external', resource_url: url.href, method: source.method, query: (source.discovery_query || source.name).slice(0, 300) }
  } catch { return null }
}

// MCP responses already carry the scoped descriptor metadata. The component's
// browser-account cache is deliberately not installed inside the iframe.
export async function loadPurchaseSource() { return null }

/** Exact App descriptor-to-field presentation, independent of account APIs. */
export function purchaseFields(endpoint: any, byName = false): InputField[] {
  const lookup = 'lookup' in endpoint ? endpoint.lookup : null
  const inputs = byName && lookup ? [...endpoint.inputs.filter((input: any) => !lookup.resolves.includes(input.field)), { field: lookup.field, required: true, schema: lookup.schema }] : endpoint.inputs
  const schema: SchemaNode = { type: 'object', properties: Object.fromEntries(inputs.map((input: any) => [input.field, input.schema])), required: inputs.filter((input: any) => input.required).map((input: any) => input.field) }
  return readFields(schema, null, 'POST').map(field => {
    let fieldSchema: SchemaNode | undefined = schema
    for (const key of field.path ?? [field.name]) fieldSchema = fieldSchema?.properties?.[key]
    if (fieldSchema?.title?.trim()) return field
    const readableName = field.name.replace(/^(path|query|body)\./, '').replace(/^source[._]input[._][a-f0-9]{16,64}[._]/i, '').split('.').at(-1) ?? field.name
    const label = readableName === 'topic' ? 'Topic or keyword' : readableName.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/^./, letter => letter.toUpperCase())
    return { ...field, label: ({ 'company_registry.kvknummer': 'KVK number', 'company.name': 'Company name', 'geo.input.q': 'Address', 'location.neighbourhood_code': 'Neighbourhood code', 'location.bag_object_id': 'BAG object ID' } as Record<string, string>)[field.name] ?? label }
  })
}

export function absoluteLogo(url: string | null | undefined) {
  return url?.startsWith('/') && !url.startsWith('//') ? new URL(url, 'https://app.apiosk.com').href : url
}
