// Deterministic views of returned rows. Never asks an LLM to recreate a full list.
import { lookupSourceTables } from './source-result-lookup-tables'
type Row = Record<string, unknown>
export type SourceTable = { title: string; columns: string[]; rows: unknown[][]; displayRows?: unknown[][]; locale?: string; total?: number; note: string; layout?: 'records' | 'table' }
const obj = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {}
const list = (v: unknown): Row[] => Array.isArray(v) ? v.map(obj) : []
const number = (v: unknown) => typeof v === "number" ? v : undefined
export function sourceResultTables(provider: unknown, path: unknown, value: unknown, related: unknown[] = [], subject?: unknown): SourceTable[] {
  const d = obj(value), p = String(path ?? "")
  const lookup = lookupSourceTables(provider, path, value)
  if (lookup.length) return lookup
  if (provider === "koop" && Array.isArray(d.items)) return [{
    title:"Official publications",columns:["Publication","Authority","Type","Published","Modified","Source"],total:number(d.total),
    note:`${String(d.notice ?? "")} ${String(obj(d.coverage).scope ?? "")}${d.next_start ? ` More results start at record ${String(d.next_start)}.` : ""}`,
    rows:list(d.items).map(r=>[r.title,r.authority,r.type,r.published,r.modified,r.url]),
  }]
  if (provider === "rdw" && Array.isArray(d.items)) return [{
    title:"RDW vehicle technical data",columns:["Plate","Make","Model","Vehicle type","APK expiry","First registration"],total:number(d.total),note:String(d.notice ?? ""),
    rows:list(d.items).map(r=>[r.kenteken,r.merk,r.handelsbenaming,r.voertuigsoort,r.vervaldatum_apk_dt ?? r.vervaldatum_apk,r.datum_eerste_toelating_dt ?? r.datum_eerste_toelating]),
  }]
  if (provider === "rvo" && Array.isArray(d.items)) return [{
    title:"RVO descriptions · partial discovery",columns:["Scheme","Description","Audience","Sector","Modified","Application status","Source"],
    note:`${String(obj(d.coverage).scope ?? "")} ${String(d.notice ?? "")} Scanned: ${String(d.scanned ?? "unknown")}; matches in this page: ${String(d.matched_in_page ?? "unknown")}.`,
    rows:list(d.items).map(r=>[r.title,r.description,r.audiences,r.sectors,r.modified,r.application_status,r.url]),
  }]
  if (provider === "ted" && Array.isArray(d.items)) return [{title:"TED identifier matches",columns:["Publication","Date","Buyer identifiers","Winner identifiers","Identity verification","Source"],total:number(d.total),note:`${String(d.notice ?? "")} ${String(obj(d.coverage).scope ?? "")}`,rows:list(d.items).map(r=>[r["publication-number"],r["publication-date"],r["buyer-identifier"],r["winner-identifier"],"Scheme and legal entity unconfirmed",r.url])}]
  if (provider === "pdok" && p.startsWith("/apiosk/") && Array.isArray(d.items)) {
    const route=String(d.route ?? ""), rows=list(d.items),note=String(d.notice ?? "")
    if(route==="company-address"||route==="bag-address") return [{layout:'records',title:"Linked BAG address",columns:["Address","BAG object ID","BAG address ID","Municipality","Neighbourhood","Parcels"],note,rows:rows.map(r=>[r.address,r.bag_object_id,r.bag_address_id,r.municipality,r.neighbourhood,r.parcel_designations])}]
    if(route==="linked-parcels") return [{layout:'records',title:"Linked cadastral parcels",columns:["Designation","Cadastral municipality","Section","Parcel number","Area (m²)"],note,rows:rows.map(r=>[r.identificatie,r.kadastrale_gemeentenaam,r.kadastrale_sectie,r.perceelnummer,r.kadastrale_grootte])}]
    if(route==="neighbourhood") return [{layout:'table',title:"CBS neighbourhood statistics · 2025",columns:["Code","Neighbourhood","Municipality","Year","Residents","Households"],note,rows:rows.map(r=>[r.buurtcode,r.buurtnaam,r.gemeentenaam,r.jaar,r.aantal_inwoners,r.aantal_huishoudens])}]
    return [{layout:'records',title:route==="building"?"BAG building":"BAG unit",columns:["BAG ID","Status","Use","Construction year","Unit area (m²)"],note,rows:rows.map(r=>[r.identificatie,r.status,r.gebruiksdoel,r.bouwjaar,r.oppervlakte])}]
  }
  if (provider === "kvk-dutch-business-register" && p.includes("basisprofielen")) {
    const owner = obj(obj(d._embedded).eigenaar), establishment = obj(obj(d._embedded).hoofdvestiging)
    const present = (value: unknown) => value != null && (typeof value !== 'string' || value.trim() !== '') && (!Array.isArray(value) || value.length > 0)
    const addresses = list(establishment.adressen).map(address => [
      address.type === 'bezoekadres' ? 'Main establishment visiting address' : address.type === 'postadres' ? 'Main establishment postal address' : 'Main establishment address',
      address.indAfgeschermd === true || /^(ja|yes|true)$/i.test(String(address.indAfgeschermd ?? ''))
        ? 'Withheld by the register'
        : address.volledigAdres,
    ])
    return [{
      title: "Company profile", columns: ["Field", "Source value"], note: "Returned KVK registration details. Missing fields remain unknown; reported persons employed are not a consolidated group headcount.",
      rows: [["KVK number",d.kvkNummer],["Registered name",d.naam],["Legal name",d.statutaireNaam],["Legal form",owner.rechtsvorm],["RSIN",owner.rsin],...list(d.handelsnamen).map(r=>["Trade name",r.naam]),["Main establishment number",establishment.vestigingsnummer],...addresses,["Employees reported",d.totaalWerkzamePersonen],...list(d.sbiActiviteiten).map(r=>["Activity",[r.sbiCode,r.sbiOmschrijving].filter(present).join(" · ")])].filter(row=>present(row[1])),
    }]
  }
  if (provider === "gleif" && Array.isArray(d.data)) return [{
    title: "Legal entity records", columns: ["Legal name", "LEI", "Entity status", "Registration status", "Country"], total:number(obj(obj(d.meta).pagination).total),
    note: "Returned GLEIF records, not a complete ownership or UBO register. Duplicate, inactive and lapsed records remain visible; record count is not a count of unique active companies.",
    rows:list(d.data).map(r=>{ const a=obj(r.attributes),e=obj(a.entity); return [obj(e.legalName).name,r.id,e.status,obj(a.registration).status,obj(e.legalAddress).country] }),
  }]
  if (provider === "companies-house" && p.includes("/filing-history") && Array.isArray(d.items)) return [{
    title:"Filing history",columns:["Filed","Form","Category","Description code","Document metadata"],total:number(d.total_count),
    note:`Returned page only${typeof d.start_index === "number" ? `, starting at record ${d.start_index + 1}` : ""}. Filing descriptions are register entries, not a review of the underlying documents.`,
    rows:list(d.items).map(r=>[r.date,r.type,r.category,r.description,obj(r.links).document_metadata]),
  }]
  const companiesHousePath=p.split(/[?#]/,1)[0].replace(/\/$/,"")
  if (provider === "companies-house" && companiesHousePath === "/search/companies" && Array.isArray(d.items)) return [{
    title:"Company search candidates",columns:["Company","Company number","Status","Type","Incorporated","Address"],total:number(d.total_results),
    note:`Search candidates, not a confirmed company match. Returned page only${typeof d.start_index === "number" ? `, starting at record ${d.start_index + 1}` : ""}.`,
    rows:list(d.items).map(r=>[r.title,r.company_number,r.company_status,r.company_type,r.date_of_creation,r.address_snippet]),
  }]
  if (provider === "companies-house" && /^\/company\/[^/]+\/(officers|persons-with-significant-control)$/.test(companiesHousePath) && Array.isArray(d.items)) {
    const psc=companiesHousePath.endsWith("/persons-with-significant-control")
    return [{title:psc?"Significant control":"Company officers",columns:psc?["Name","Status","Notified","Ceased","Nature of control"]:["Name","Role","Status","Appointed","Resigned"],total:number(d.total_results),
      note: psc ? d.items.length ? "This is the returned register page of people and entities with significant control. Ceased records are explicitly labelled; this is not a complete register of ultimate owners." : "No significant-control records were returned. This does not establish the absence of ultimate owners." : "This is the returned register page. Historic records are included and explicitly labelled; an officer is not necessarily a director.",
      rows:list(d.items).map(r=>psc?[r.name,r.ceased===true||r.ceased_on?"Ceased":"Active",r.notified_on,r.ceased_on,Array.isArray(r.natures_of_control)?r.natures_of_control.join("; "):undefined]:[r.name,r.officer_role,r.resigned_on?"Resigned":"Active",r.appointed_on,r.resigned_on])}]
  }
  if (provider === "companies-house" && typeof d.company_number === "string") return [{title:"Company profile",columns:["Field","Source value"],note:"Companies House registered-entity information.",rows:[["Name",d.company_name],["Company number",d.company_number],["Status",d.company_status],["Incorporated",d.date_of_creation],["Latest accounts period end",obj(obj(d.accounts).last_accounts).period_end_on]]}]
  if (provider === "tenderned" && Array.isArray(d.content)) return [{title:"Tender publications",columns:["Publication","Authority","Type","Published","Closing date","Source"],total:number(d.totalElements),
    note:"Search results can include awards, corrections and historic notices. A published notice is not necessarily an open tender. Missing closing dates are not evidence that bidding is open.",
    rows:list(d.content).map(r=>[r.aanbestedingNaam,r.opdrachtgeverNaam,obj(r.typePublicatie).omschrijving,r.publicatieDatum,r.sluitingsDatum,obj(r.link).href])}]
  if (provider === "data-overheid-nl" && Array.isArray(obj(d.result).results)) return [{title:"Dataset catalogue",columns:["Dataset","Publisher","Resource links"],total:number(obj(d.result).count),note:"Catalogue metadata, not measurements. Publisher and catalogue organisation are different roles. Links may lead to documentation or services.",rows:list(obj(d.result).results).map(r=>[r.title,r.publisher,list(r.resources).map(x=>x.url).filter(x=>typeof x==='string')])}]
  if (provider === "pdok" && Array.isArray(obj(d.response).docs)) {
    const rows=list(obj(d.response).docs),normalize=(v:string)=>v.trim().toLocaleLowerCase("nl-NL").replace(/\s+/g," ")
    const exact=typeof subject==='string'?rows.filter(r=>r.type==='adres'&&[r.straatnaam,r.huis_nlt,r.woonplaatsnaam].every(v=>typeof v==='string')&&normalize(`${r.straatnaam} ${r.huis_nlt} ${r.woonplaatsnaam}`)===normalize(subject)):[]
    const matched=exact.length===1
    return [{layout:'records',title:matched?"Exact address match":"Address search candidates",columns:["Result","Type","Postcode","Municipality","Neighbourhood"],total:matched?undefined:number(obj(d.response).numFound),note:matched?`Street, house number and city match the requested address exactly in this returned page of ${rows.length} candidates.`:"Search candidates, not verified matches. Check the full address and result type; the first result can be a street rather than the requested house.",rows:(matched?exact:rows).map(r=>[r.weergavenaam,r.type,r.postcode,r.gemeentenaam,r.buurtnaam])}]
  }
  if (provider === "overheid-io" && Array.isArray(obj(d._embedded).adres)) return [{layout:'records',title:"BAG addresses",columns:["Street","House number","Letter","Addition","Postcode","City"],total:number(d.totalItemCount),note:"The returned page is saved in this result. Total matches may span additional source pages.",rows:list(obj(d._embedded).adres).map(r=>[r.openbareruimte,r.huisnummer,r.huisletter,r.huisnummertoevoeging,r.postcode,r.woonplaats])}]
  if (provider === "opensanctions" && d.responses) return Object.entries(obj(d.responses)).map(([key,value])=>{const r=obj(value);return {title:`Screening · ${key}`,columns:["Candidate","Score","Datasets"],total:number(obj(r.total).value),note:Number(r.status)!==200?"This screening query failed; no conclusion can be drawn.":"No matches means no candidates returned for this query, not a guarantee of safety. Review identity and source coverage before drawing conclusions.",rows:list(r.results).map(x=>[x.caption,x.score,Array.isArray(x.datasets)?x.datasets.join(", "):undefined])}})
  if (provider === "cbs-statline" && Array.isArray(d.value)) {
    if(p.endsWith("Observations")) {
      const table=String(d["@odata.context"]??"").match(/\/CBS\/([^/]+)\/\$metadata/)?.[1]
      const definition=(set:string,code:unknown,field="Title")=>{
        if(!table||typeof code!=="string")return undefined
        const found=related.flatMap(doc=>{
          const item=obj(doc),source=obj(item.source),body=obj(item.data),context=String(body["@odata.context"]??"")
          if(source.provider!=="cbs-statline"||!context.includes(`/CBS/${table}/$metadata#${set}`))return []
          return list(body.value).filter(r=>r.Identifier===code&&typeof r[field]==="string").map(r=>r[field] as string)
        })
        const unique=[...new Set(found)];return unique.length===1?unique[0]:undefined
      }
      const label=(set:string,code:unknown)=>{const title=definition(set,code);return title?`${title} (${String(code)})`:code}
      return [{layout:'table',title:"CBS observations",columns:["Period","Measure","Sector","Entity type","Value","Unit","Flag"],total:number(d["@odata.count"]),note:"Labels are joined by code to the official definitions for this same table. Unresolved codes stay visible. Returned page only; do not sum overlapping sectors or monthly, quarterly and annual periods.",rows:list(d.value).map(r=>[r.Perioden,label("MeasureCodes",r.Measure),label("BedrijfstakkenBranchesSBI2008Codes",r.BedrijfstakkenBranchesSBI2008),label("TypeGefailleerdeCodes",r.TypeGefailleerde),r.Value,definition("MeasureCodes",r.Measure,"Unit"),r.ValueAttribute])}]
    }
    const keys = p.endsWith("Observations") ? ["Perioden","Measure","BedrijfstakkenBranchesSBI2008","TypeGefailleerde","Value","ValueAttribute"] : ["Identifier","Title","Unit"]
    return [{layout:'table',title:p.endsWith("Observations")?"CBS observations":"CBS definitions",columns:keys,total:number(d["@odata.count"]),note:"Returned page only. Resolve measure, sector and type codes with the official definitions. Do not add together monthly, quarterly and annual periods or overlapping sectors.",rows:list(d.value).map(r=>keys.map(k=>r[k]))}]
  }
  if (provider === "eurostat" && Array.isArray(d.id) && Array.isArray(d.size) && d.value) {
    const ids=d.id.filter((x):x is string=>typeof x==='string'),sizes=d.size as number[],dims=obj(d.dimension)
    if(ids.length!==sizes.length || sizes.some(n=>!Number.isSafeInteger(n)||n<1)) return []
    const codes=ids.map(id=>{const index=obj(obj(dims[id]).category).index;return Array.isArray(index)?index.map(String):Object.entries(obj(index)).sort((a,b)=>Number(a[1])-Number(b[1])).map(([k])=>k)})
    const entries=Object.entries(obj(d.value)),cap=1000
    const headings:Record<string,string>={freq:"Frequency",unit:"Unit",na_item:"Indicator",geo:"Country",time:"Period"}
    return [{layout:'table',title:typeof d.label==='string'?d.label:"Eurostat observations",columns:[...ids.map(id=>headings[id]??id),"Value","Flag"],total:entries.length,note:`Units and periods are shown per observation; values are not rescaled. ${entries.length>cap?`First ${cap} values are available in this view; full source JSON remains available.`:"All returned values are available in this result."}`,rows:entries.slice(0,cap).map(([index,v])=>{
      let coordinate=Number(index);const coordinates=new Array(ids.length)
      for(let i=ids.length-1;i>=0;i--){coordinates[i]=coordinate%sizes[i];coordinate=Math.floor(coordinate/sizes[i])}
      return [...ids.map((id,i)=>{const code=codes[i][coordinates[i]],label=obj(obj(obj(dims[id]).category).label)[code];return label&&label!==code?`${label} (${code})`:code}),v,obj(d.status)[index]]
    })}]
  }
  return []
}
