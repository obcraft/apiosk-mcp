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

  lines.push("", "| # | Provider | Source | Buy | Price (USDC) |", "| --- | --- | --- | --- | --- |");
  for (const row of rows) {
    const buy = row.external ? "pay provider directly" : "via Apiosk";
    const price =
      typeof row.price_usdc === "number"
        ? `${row.price_usdc}${row.price_includes_apiosk_fee ? " (incl. 10% fee)" : ""}`
        : "not published";
    lines.push(
      `| ${row.index} | ${rowName(row)}${rowDescription(row)} | ${row.source} | ${buy} | ${price} |`
    );
  }

  const hidden = totalExternal - shownExternal;
  if (hidden > 0) {
    lines.push("", `${hidden} further external endpoint${hidden === 1 ? "" : "s"} were found and are in \`results\` — say the word to see them.`);
  }
  lines.push(
    "",
    "Rows marked *via Apiosk* are reviewed listings the gateway prices and settles. Rows marked *pay provider directly* are live x402 endpoints Apiosk found but has not reviewed or measured, and cannot settle from here. Nothing has been paid for."
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
export function renderOffers(payload, offers) {
  const lines = [];
  const capability = trimString(payload?.capability);
  const expires = Number(payload?.expires_in_seconds);

  lines.push(
    `**${offers.length} offer${offers.length === 1 ? "" : "s"}**${capability ? ` for \`${capability}\`` : ""} — nothing is paid until you pick one.`
  );

  if (!offers.length) {
    lines.push("", "No provider survived the requirements you set. Relax the binding constraint, or ask what was rejected and why.");
    return lines.join("\n");
  }

  lines.push(
    "",
    "| # | Provider | Price (USDC) | Score | p95 latency | Success rate |",
    "| --- | --- | --- | --- | --- | --- |"
  );
  for (const offer of offers) {
    const price = typeof offer.price_usdc === "number" ? `${offer.price_usdc} (incl. 10% fee)` : "not published";
    // Never a plausible default: a provider Apiosk has not proxied is unmeasured,
    // and a zero here would read as "instant" or "always fails".
    const latency = Number.isFinite(offer.p95_latency_ms) ? `${Math.round(offer.p95_latency_ms)} ms` : "not measured";
    const success = Number.isFinite(offer.success_rate)
      ? `${Math.round(offer.success_rate * (offer.success_rate <= 1 ? 100 : 1))}%`
      : "not measured";
    const score = Number.isFinite(offer.score) ? String(Math.round(offer.score)) : "—";
    lines.push(
      `| ${offer.index} | ${rowName({ name: offer.provider, listing_slug: offer.api_slug })} | ${price} | ${score} | ${latency} | ${success} |`
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

  if (Number.isFinite(expires) && expires > 0) {
    lines.push("", `These prices are pinned for ${Math.round(expires / 60)} minutes. After that, ask for a fresh comparison.`);
  }
  lines.push("", "Say the number you want. Nothing has been paid for.");
  return lines.join("\n");
}
