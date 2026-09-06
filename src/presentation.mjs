// How a result is put in front of a person.
//
// Serves the same rule as mcp/05: the user ends the flow reading a sentence,
// not a json blob, and the agent should not have to infer the shape of the
// answer from prose. Both steps that show a list — discovery's candidates and
// the comparison's priced offers — render here rather than in the module that
// fetched them, because what is searched and how it is shown are two decisions,
// and because src/discovery.mjs was already at the 20 KB line the surface test
// holds.
//
// The rule for everything in this file: the model is handed finished text and
// asked to relay it. Every time that job was described in prose instead, the
// model did something else with it.

import { sanitizeText, trimString } from "./discovery-text.mjs";

/** Descriptions in the table are a hint, not the documentation. */
const TABLE_DESCRIPTION_CHARS = 110;

/**
 * What to call a row, when the provider's name does not identify the API.
 *
 * Several listings can sit under one publisher account, so six different news
 * and market-data APIs came back as six rows all called "Apiosk Basics" — a
 * table a person cannot choose from. The listing slug is what actually names
 * the thing being bought, so it is shown beside the publisher whenever the
 * publisher's name does not already contain it.
 */
function rowName(row) {
  const name = row.name || row.listing_slug || row.host || "unnamed";
  const slug = trimString(row.listing_slug);
  if (!slug) return `**${name}**`;
  const flattened = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const flattenedSlug = slug.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (flattened.includes(flattenedSlug) || flattenedSlug.includes(flattened)) return `**${name}**`;
  return `**${name}** \`${slug}\``;
}

/** The description, cut to a phone-readable length. The full text stays in `results`. */
function rowDescription(row) {
  const description = sanitizeText(row.description || "", TABLE_DESCRIPTION_CHARS);
  return description ? `<br><small>${description}</small>` : "";
}

/**
 * A host name, as a person would say it.
 *
 * `www.x402financialdata.com` is a URL, not a supplier, and a table that names
 * its rows that way is asking the reader to parse DNS. Worse, a bare domain in
 * bold is auto-linked by most chat clients, which is how a provider column ends
 * up rendering as broken markdown.
 *
 * So the domain is read as words: the registrable label, split on the
 * separators a domain actually uses and then on the dictionary below, and
 * title-cased. The split is only accepted when EVERY piece is a word we know —
 * anything else keeps the label whole rather than guessing at where the seams
 * are and inventing a name nobody chose.
 */
const HOST_WORDS = [
  "x402", "api", "apis", "ai", "data", "financial", "finance", "news", "market",
  "markets", "price", "prices", "pricing", "search", "crypto", "chain", "block",
  "weather", "earnings", "stock", "stocks", "equity", "oracle", "index", "feed",
  "feeds", "quote", "quotes", "trade", "trading", "token", "tokens", "wallet",
  "pay", "payments", "agent", "agents", "cloud", "labs", "lab", "hub", "net",
  "web", "dev", "tools", "tool", "info", "live", "star", "lone", "sports",
  "image", "images", "vision", "text", "translate", "geo", "maps", "map",
];
const HOST_ACRONYMS = { ai: "AI", api: "API", apis: "APIs", x402: "x402", nft: "NFT", llm: "LLM" };
/** Domains where the registrable label is the platform, not the supplier. */
const PAAS_SUFFIXES = [
  "vercel.app", "netlify.app", "herokuapp.com", "fly.dev", "onrender.com",
  "workers.dev", "pages.dev", "railway.app", "replit.dev", "run.app",
  "azurewebsites.net", "amazonaws.com", "cloudfunctions.net", "ngrok.app",
];
const SOURCE_LABELS = {
  apiosk: "Apiosk",
  "coinbase-x402-bazaar": "Coinbase Bazaar",
  "x402-bazaar": "x402 Bazaar",
  bazaar: "x402 Bazaar",
  payai: "PayAI",
  thirdweb: "thirdweb",
  external: "x402 index",
};

/** Split a run of letters into known words, longest first. Null if any part is unknown. */
function splitWords(label) {
  if (!label) return null;
  const words = [...HOST_WORDS].sort((a, b) => b.length - a.length);
  const out = [];
  let rest = label;
  while (rest) {
    const match = words.find((word) => rest.startsWith(word));
    if (!match) return null;
    out.push(match);
    rest = rest.slice(match.length);
  }
  return out.length ? out : null;
}

function titleCase(word) {
  return HOST_ACRONYMS[word] || word.charAt(0).toUpperCase() + word.slice(1);
}

/** `www.x402financialdata.com` → `x402 Financial Data`. */
export function prettyHost(host) {
  const clean = trimString(host)
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .replace(/^www\./, "");
  if (!clean) return "";
  // The label that names the thing: normally the registrable one
  // (`api.marketdata.app` is Market Data), but the first one when the domain
  // belongs to a hosting platform, where the registrable label names the host
  // rather than the supplier (`x402-news.vercel.app` is not Vercel).
  const parts = clean.split(".").filter(Boolean);
  const onPlatform = PAAS_SUFFIXES.some((suffix) => clean.endsWith(`.${suffix}`));
  const label = onPlatform ? parts[0] : parts[parts.length - 2] || parts[0];
  const pieces = label.split(/[-_]/).filter(Boolean);
  const named = pieces
    .map((piece) => {
      const split = splitWords(piece);
      return split ? split.map(titleCase).join(" ") : titleCase(piece);
    })
    .join(" ");
  return named || clean;
}

/** Which index a row came from, in words rather than a slug. */
export function prettySource(source) {
  const key = trimString(source).toLowerCase();
  if (!key) return "x402 index";
  if (SOURCE_LABELS[key]) return SOURCE_LABELS[key];
  return key
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => HOST_ACRONYMS[word] || word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * A price, as a person reads one.
 *
 * A bare `0.033` with a currency in the column header is a number a reader has
 * to decode; `$0.033` is a price. What the number INCLUDES is said once under
 * the table instead of repeated in every cell — a fee note glued to each row
 * makes the column unreadable at exactly the width where the decision is made.
 * Rounded to USDC's six decimals so float arithmetic never puts fifteen digits
 * on the screen.
 */
function money(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "not published";
  return `$${Math.round(value * 1e6) / 1e6}`;
}

/**
 * The answer, rendered here rather than described to the model.
 *
 * Guidance that says "present these as a table with these five columns" is a
 * paragraph of prose competing with a model's own instincts, and the instincts
 * win: asked for Nvidia news, one produced a bare list of five Apiosk providers
 * and silently dropped twenty-five external endpoints it had been handed. The
 * fix is not a longer instruction. It is to do the formatting here, where it is
 * deterministic, and leave the model one job — relay it.
 *
 * The three pipeline lines come first for the same reason they exist: they are
 * the difference between "the shelf is empty" and "your question was misread".
 */
export function renderPresentation(pipeline, rows, { totalExternal, shownExternal }) {
  const lines = [];
  const read = pipeline.step_1_read;
  const extend = pipeline.step_2_extend;
  const search = pipeline.step_3_search;

  const needLine = read.needs
    .map((need) => `${need.need}${need.keywords.length ? ` — searched for: ${need.keywords.join(", ")}` : ""}`)
    .join("; ");
  lines.push(`**Read as:** ${needLine || "the words as written"}`);

  if (extend.status === "enriched" && extend.needs.length) {
    const vocabulary = extend.needs
      .map((need) => {
        const parts = [];
        if (need.tags.length) parts.push(`tags: ${need.tags.join(", ")}`);
        if (need.categories.length) parts.push(`categories: ${need.categories.join(", ")}`);
        if (need.sectors.length) parts.push(`sectors: ${need.sectors.join(", ")}`);
        return parts.join(" · ");
      })
      .filter(Boolean)
      .join("; ");
    lines.push(`**Extended with:** ${vocabulary || "nothing new"}`);
  } else {
    lines.push("**Extended with:** not run — the words above were searched as they are");
  }

  lines.push(
    `**Searched:** ${search.sources_searched.length} source${search.sources_searched.length === 1 ? "" : "s"} → ${search.reviewed_found} via Apiosk, ${totalExternal} external`
  );

  if (!rows.length) {
    lines.push("", "Nothing came back for this job — not in the reviewed catalogue and not in the x402 indexes that were searched. Nothing was paid for.");
    return lines.join("\n");
  }

  lines.push("", "| # | Provider | Source | Buy | Price |", "| --- | --- | --- | --- | --- |");
  for (const row of rows) {
    // An external endpoint is not automatically unbuyable: the gateway fronts
    // the provider's own 402 and bills list + 15%, so most of these rows are
    // bought exactly like a catalogue one. The gateway said which; this only
    // prints it.
    const buy = row.settlement === "direct" ? "pay provider directly" : "via Apiosk";
    const name = row.external ? rowName({ ...row, name: prettyHost(row.name) }) : rowName(row);
    lines.push(
      `| ${row.index} | ${name}${rowDescription(row)} | ${prettySource(row.source)} | ${buy} | ${money(row.price_usdc)} |`
    );
  }

  const hidden = totalExternal - shownExternal;
  if (hidden > 0) {
    lines.push("", `${hidden} further external endpoint${hidden === 1 ? "" : "s"} were found and are in \`results\` — say the word to see them.`);
  }
  lines.push(
    "",
    "Every price is what leaves your wallet. Rows marked *via Apiosk* are settled by the gateway with Apiosk's 15% already in the price — the ones from the Apiosk catalogue are reviewed listings, the ones from an x402 index are endpoints Apiosk found, has never measured, and pays on your behalf. Rows marked *pay provider directly* are ones Apiosk will not settle: their price is the provider's own and you would call the URL and pay its 402 yourself. Nothing has been paid for."
  );
  return lines.join("\n");
}

/**
 * The pipeline that produced the results, as three steps a person can read.
 *
 * The gateway runs discovery as a chain — read the job, extend it into the
 * vocabulary a marketplace files it under, then search everything with both
 * vocabularies — and returns each step's own output. Handing back only the last
 * one makes the answer unarguable: a user who sees "here are seven news APIs"
 * cannot tell whether their question was understood, and a user who sees
 * nothing cannot tell whether the shelf is empty or the question was misread.
 * Steps 1 and 2 are exactly the difference.
 */
export function pipelineOf(payload, counts) {
  const interpretation = payload?.interpretation ?? null;
  const extension = payload?.extension ?? null;
  const labels = (list) => (Array.isArray(list) ? list.map((item) => sanitizeText(item, 60)).filter(Boolean) : []);

  return {
    step_1_read: {
      // "parsed" — a model split the request into needs. "verbatim" — it was
      // searched as written, which is what a keyword query gets.
      status: trimString(interpretation?.source) || "not_run",
      model: interpretation?.model ?? null,
      ms: interpretation?.parse_ms ?? null,
      needs: (Array.isArray(interpretation?.tasks) ? interpretation.tasks : []).map((task) => ({
        need: sanitizeText(task?.need || "", 160),
        keywords: labels(task?.keywords),
      })),
    },
    step_2_extend: {
      // "enriched" — the vocabulary below was added. "fell_back"/"empty" — it
      // was attempted and produced nothing, so step 3 searched step 1's words
      // alone. "not_run" — a keyword query or a named capability, where there
      // was no reading to extend.
      status: trimString(extension?.source) || "not_run",
      model: extension?.model ?? null,
      ms: extension?.enrich_ms ?? null,
      needs: (Array.isArray(extension?.needs) ? extension.needs : []).map((need) => ({
        need: sanitizeText(need?.need || "", 160),
        tags: labels(need?.tags),
        categories: labels(need?.categories),
        sectors: labels(need?.sectors),
        extra_terms: labels(need?.extra_terms),
      })),
    },
    step_3_search: {
      sources_searched: counts.sources,
      reviewed_found: counts.reviewed,
      external_found: counts.external,
    },
  };
}

/**
 * The priced offers, as a table with a number the user can say back.
 *
 * Four things have to survive the trip to the screen, and prose guidance was
 * losing all four: the price is the buyer total and must be quoted as-is, an
 * unmeasured dimension is unmeasured rather than zero, the quote expires, and
 * the buyer's own rules may already refuse an offer that is otherwise the
 * cheapest. Rendering them here is how they stop being optional.
 */
export function renderOffers(payload, offers, external = []) {
  const lines = [];
  const capability = trimString(payload?.capability);
  const expires = Number(payload?.expires_in_seconds);
  const rows = [...offers, ...external];
  const direct = external.filter((offer) => offer.settlement !== "apiosk");

  lines.push(
    `**${rows.length} offer${rows.length === 1 ? "" : "s"}**${capability ? ` for \`${capability}\`` : ""} — nothing is paid until you pick one.`
  );

  if (!rows.length) {
    lines.push("", "No provider survived the requirements you set. Relax the binding constraint, or ask what was rejected and why.");
    return lines.join("\n");
  }

  if (!offers.length) {
    lines.push(
      "",
      "Nothing in the reviewed Apiosk catalogue serves this job. Everything below was found in the wider x402 ecosystem and has not been reviewed."
    );
  }

  // Four columns, because a person choosing between suppliers is choosing on
  // who, where it came from, and what it costs. The measured columns used to
  // sit here too and were the same two words on every row — "not measured" —
  // which is a table teaching the reader to skip it. What Apiosk has measured
  // is still in `offers`; it earns a column again when there is something in it.
  lines.push("", "| # | Provider | Source | Price |", "| --- | --- | --- | --- |");
  for (const offer of offers) {
    lines.push(
      `| ${offer.index} | ${rowName({ name: offer.provider, listing_slug: offer.api_slug })} | Apiosk catalogue | ${money(offer.price_usdc)} |`
    );
  }
  for (const offer of external) {
    // Where it came from, and — when Apiosk cannot pay it for you — that fact,
    // because it changes what picking the row means.
    const source = `${prettySource(offer.source)}${offer.settlement === "apiosk" ? "" : " · pay the provider yourself"}`;
    lines.push(
      `| ${offer.index} | ${rowName({ name: prettyHost(offer.provider) })}${rowDescription(offer)} | ${source} | ${money(offer.price_usdc)} |`
    );
  }

  const held = offers.filter((offer) => trimString(offer.policy?.verdict) === "require_approval");
  const denied = offers.filter((offer) => trimString(offer.policy?.verdict) === "deny");
  for (const offer of denied) {
    lines.push("", `⚠️ #${offer.index} is refused by your own spending rules: ${sanitizeText(offer.policy?.reason || "no reason given", 160)}`);
  }
  for (const offer of held) {
    lines.push("", `⏸️ #${offer.index} would be held for your approval: ${sanitizeText(offer.policy?.reason || "no reason given", 160)}`);
  }

  if (Number.isFinite(expires) && expires > 0 && offers.length) {
    lines.push("", `These prices are pinned for ${Math.round(expires / 60)} minutes. After that, ask for a fresh comparison.`);
  }

  // One sentence about the price, under the table rather than inside every
  // cell: the number in the column is what leaves the wallet, whichever half of
  // the market the row came from.
  lines.push(
    "",
    direct.length
      ? "Every price is what leaves your wallet. Apiosk settles every row except the ones marked below, and its 15% is already in those prices. Rows from the catalogue are reviewed listings; rows from an x402 index are endpoints Apiosk found, has never measured, and pays on your behalf."
      : "Every price is what you pay, Apiosk's 15% fee included. Apiosk settles the call either way: rows from the catalogue are reviewed listings; rows from an x402 index are endpoints Apiosk found, has never measured, and pays on your behalf."
  );

  if (direct.length) {
    const numbers = direct.map((offer) => `#${offer.index}`).join(", ");
    lines.push(
      "",
      `${numbers} ${direct.length === 1 ? "is one Apiosk cannot pay for you" : "are ones Apiosk cannot pay for you"} — ${sanitizeText(direct[0].settlement_reason || "the gateway will not settle this host", 200)} The price shown is the provider's own; you would call ${direct.length === 1 ? "its URL" : "their URLs"} and pay the 402 yourself.`
    );
  }

  lines.push("", "Say the number you want. Nothing has been paid for.");
  return lines.join("\n");
}
