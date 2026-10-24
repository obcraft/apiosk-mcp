import { displayData, formatDisplayNarrative } from "@/lib/ui/display-text"
import { config } from "@/lib/platform/config"
import { useGatewayV2Money } from "@/components/ask/gateway-v2-money"
import { savedFilingRows } from "@/lib/domain/saved-filing-rows"
import { sourceResultTables } from "@/lib/domain/source-result-tables"
import { SourceResultTable } from "@/components/ask/source-result-table"
import { ResponseText } from '@/components/response/response-text'
import { LinkPreviewCard } from '@/components/response/link-preview'
import { ResultTable } from '@/components/response/result-table'
import { ResultMediaGallery } from '@/components/response/result-media'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export type ResultChargeAllocation = { amount: string; previousAmount: string }

export function GatewayV2Result({
  result,
  related = [],
  chargeAllocation,
  summaryOnly = false,
  showMedia = true,
}: {
  result: unknown
  related?: unknown[]
  chargeAllocation?: ResultChargeAllocation
  summaryOnly?: boolean
  showMedia?: boolean
}) {
  const formatMoney = useGatewayV2Money()

  const item = record(result)
  const source = record(item.source)
  const data = record(displayData(item.data))

  const report = record(record(result).report)
  const reportPath =
    typeof report.download_path === "string" &&
    /^\/v2\/tasks\/[0-9a-f-]+\/results\/[0-9a-f-]+\/report\.pdf\?/.test(report.download_path)
      ? report.download_path
      : null
  const reportUrl = reportPath && config.gatewayV2Url ? new URL(reportPath, config.gatewayV2Url).href : null
  // Maps captured when the result was bought (e.g. a Bodemloket or PDOK map
  // pixel), served by the gateway behind a signed, expiring link.
  const maps = (Array.isArray(record(item.report_assets).assets) ? record(item.report_assets).assets as unknown[] : [])
    .map(record)
    .filter(asset => asset.kind === "map" && typeof asset.download_path === "string" &&
      /^\/v2\/tasks\/[0-9a-f-]+\/results\/[0-9a-f-]+\/assets\/\d+\?/.test(asset.download_path))
    .flatMap(asset => config.gatewayV2Url ? [{
      url: new URL(asset.download_path as string, config.gatewayV2Url).href,
      name: typeof asset.name === "string" ? asset.name : "Map",
      source: typeof asset.source_url === "string" && /^https:\/\//i.test(asset.source_url) ? asset.source_url : null,
    }] : [])

  const tables = sourceResultTables(source.provider, source.path, item.data ?? item.preview_data, related, record(item.subject).label)
  const subject = record(item.subject).label
  const filing = savedFilingRows(source.provider, source.path, item.data ?? item.preview_data)
  const companies =
    Array.isArray(data.resultaten) && data.resultaten.every(row => typeof record(row).naam === "string" && typeof record(row).kvkNummer === "string")
      ? data.resultaten.map(record)
      : null
  const url = typeof source.url === "string" && /^https:\/\//i.test(source.url) ? source.url : null
  const name = typeof source.name === "string" ? source.name : typeof source.provider === "string" ? source.provider : null

  const core = <div className="space-y-3">
    <h2 className="font-medium">{typeof subject === "string" ? `Result · ${formatDisplayNarrative(subject, item)}` : "Result"}</h2>
    {summaryOnly && name && <p className="text-tiny text-muted">Saved source data · {name}</p>}
    {reportUrl && (
      <a href={reportUrl} target="_blank" rel="noreferrer" className="inline-flex rounded-lg border border-border-2 px-4 py-2 text-body font-medium">
        Download jaarrekeningrapport (PDF)
      </a>
    )}
    {maps.map(map => <figure key={map.url} className="overflow-hidden rounded-lg border border-border-2 bg-surface">
      <img src={map.url} alt={map.name} loading="lazy" referrerPolicy="no-referrer" className="block h-auto w-full bg-surface-2" />
      <figcaption className="px-3 py-2 text-tiny text-muted">{map.name}{map.source && <LinkPreviewCard href={map.source} className="mt-2" />}</figcaption>
    </figure>)}
    {showMedia && <ResultMediaGallery value={item.data ?? item.preview_data} exclude={[...tables.map(table => table.rows), filing?.rows]} label={name ? `Media · ${name}` : 'Source media'} />}
    {tables.map((table, i) => <SourceResultTable key={i} table={table} />)}
    {filing && <p className="text-tiny text-muted">Selected fields from the deposited annual accounts. {filing.currency ? `Currency: ${filing.currency}.` : "No currency is specified in this response."}</p>}
    {companies && <div className="min-w-0 space-y-3">
      <p className="mb-3 text-body text-muted">
        {companies.length} results shown{typeof data.totaal === "number" ? ` of ${data.totaal}` : ""}
        {typeof data.pagina === "number" ? ` · Page ${data.pagina}` : ""}
      </p>
      <ResultTable label="Company results" columns={['Company', 'KVK number', 'City']} rows={companies.map(row => [String(row.naam), String(row.kvkNummer), String(record(record(row.adres).binnenlandsAdres).plaats ?? '—')])} />
      {typeof data.volgende === "string" && <p className="mt-3 text-body text-muted">The source has more results. This response contains the current page.</p>}
    </div>}
    {filing && <div className="space-y-3">
      <dl className="divide-y divide-border-2 rounded-lg bg-surface px-3">
        {filing.rows.map(([label, value], i) => (
          <div key={i} className="grid gap-1 py-2 text-body sm:grid-cols-2 sm:gap-4">
            <dt className="text-muted">{label}</dt>
            <dd className="break-words tabular-nums"><ResponseText text={value} /></dd>
          </div>
        ))}
      </dl>
    </div>}
  </div>

  const details = <>
    <details>
      <summary className="cursor-pointer py-2 text-body font-medium">View full result</summary>
      <details open={!companies && !filing}>
        <summary className="cursor-pointer text-body text-muted">Source JSON</summary>
        <p className="text-tiny text-muted">
          {item.encoding === "json_text"
            ? "Large saved response. Load the full saved result to view all available source data."
            : "JSON returned by the source"}
        </p>
        <pre
          aria-label="Source JSON"
          className="max-h-[32rem] overflow-auto rounded-lg border border-border-2 bg-[color:var(--input-bg)] p-4 text-tiny whitespace-pre-wrap break-words"
        >
          {item.encoding === "json_text"
            ? String(item.text ?? "")
            : JSON.stringify(Object.prototype.hasOwnProperty.call(item, "data") ? item.data : result, null, 2)}
        </pre>
      </details>
    </details>
    {typeof source.provider === "string" && (
      <details className="text-body text-muted">
        <summary className="cursor-pointer">Sources</summary>
        <p className="mt-2">
          Source: {url ? <LinkPreviewCard href={url} title={name ?? undefined} /> : name}
          {typeof source.retrieved_at === "string" ? ` · Retrieved ${new Date(source.retrieved_at).toLocaleString()}` : ""}
        </p>
      </details>
    )}
    {typeof item.charged_atomic === "string" && <p>Charged: {formatMoney(item.charged_atomic, false, undefined, chargeAllocation?.amount === item.charged_atomic ? chargeAllocation.previousAmount : undefined)}</p>}
    {Array.isArray(item.missing_fields) && item.missing_fields.length > 0 && <p>Missing information: {item.missing_fields.join(", ")}</p>}
    <details>
      <summary className="cursor-pointer text-body text-muted">Full source data</summary>
      <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-tiny">{JSON.stringify(result, null, 2)}</pre>
    </details>
  </>

  return (
    <div className="answer-content space-y-3">
      {core}
      {summaryOnly ? Array.isArray(item.missing_fields) && item.missing_fields.length > 0 && <p>Missing information: {item.missing_fields.join(", ")}</p> : details}
    </div>
  )
}
