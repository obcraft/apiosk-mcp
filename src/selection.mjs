// One answer to "what are the choices, and what is each one called".
//
// Three surfaces put the same list of offers in front of a person — the
// elicitation picker a host draws natively (src/elicit.mjs), the HTML picker a
// widget host renders (src/results-picker.mjs), and the prose a text-only host
// falls back to. Each of them used to decide for itself what a row was called
// and which fields were worth showing, which is how the same offer read as
// "Apiosk Basics", "openweather-current" and "**OpenWeather** `current`" in one
// conversation.
//
// So the label is decided ONCE, here, and the three renderings are three views
// of this object.
//
// ONE PRICE. `price_usdc` is what comes off the balance, and it is the only
// number in a label. There is no list price, provider leg or fee anywhere in
// this file, because there is no surface in this product that shows what a call
// is composed of.
//
// NO NUMBERED MENUS. Options carry a stable `id` and a spoken `title`, so an
// answer is "the OpenWeather one" rather than "3" — a number is the one reply
// that means nothing when somebody comes back to the conversation an hour
// later. The skill file states the same rule for agents that have no picker.

import { sanitizeText, trimString } from "./discovery-text.mjs";

/** How many rows a person can actually weigh at once. */
export const MAX_OPTIONS = 6;

/** Labels stay short enough to read in a picker row on a phone. */
const TITLE_CHARS = 64;
const HINT_CHARS = 120;

function money(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value * 1e6) / 1e6;
}

/** `$0.002`, and `—` when the source published no price. */
export function priceLabel(value) {
  const price = money(value);
  if (price === null) return "—";
  return `$${price.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}

/**
 * What to call a row.
 *
 * The publisher's name alone does not identify the API — several listings sit
 * under one account, so six different feeds came back as six rows all called
 * "Apiosk Basics". The listing slug is what names the thing being bought, so it
 * joins the publisher whenever the publisher's name does not already contain
 * it. Same rule as the discovery table in src/presentation.mjs.
 */
export function optionName(row) {
  const name = trimString(row?.name) || trimString(row?.provider) || trimString(row?.listing_slug) || "unnamed";
  const slug = trimString(row?.listing_slug);
  if (!slug) return sanitizeText(name, TITLE_CHARS);
  const flat = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (flat(name).includes(flat(slug)) || flat(slug).includes(flat(name))) return sanitizeText(name, TITLE_CHARS);
  return sanitizeText(`${name} (${slug})`, TITLE_CHARS);
}

/**
 * The one line a picker row shows: what it is called, and what it costs.
 *
 * Relevance joins it only when the gateway measured one. A plausible default in
 * this position is worse than a blank, because a person reading "70/100" cannot
 * tell a measurement from a guess.
 */
export function optionTitle(row) {
  const parts = [optionName(row), priceLabel(row?.price_usdc)];
  const relevance = Number(row?.relevance);
  if (Number.isFinite(relevance)) parts.push(`${Math.round(relevance)}/100`);
  return parts.join(" · ");
}

/**
 * Turn discovery, comparison or ask rows into the shared choice object.
 *
 * Only rows that can actually be bought get in: no `offer_token` means the
 * gateway did not price it, and an option a person can pick but nothing can run
 * is a dead end with a price on it.
 *
 * @param {Array} rows        normalised rows (src/discovery.mjs `normalizeResult`)
 * @param {object} options
 * @param {string} options.query   the job in the user's words, carried into execute
 * @param {number} [options.limit] how many options to offer
 */
export function buildSelection(rows, { query, limit = MAX_OPTIONS } = {}) {
  const job = trimString(query);
  const ceiling = Math.max(1, Math.min(MAX_OPTIONS, Number.isFinite(limit) ? limit : MAX_OPTIONS));
  const options = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object") continue;
    const offerToken = trimString(row.offer_token);
    if (!offerToken) continue;
    if (options.length >= ceiling) break;

    const price = money(row.price_usdc);
    options.push({
      // Positional and short, because it is an enum `const` in a picker and a
      // key in a widget — never shown to a person, who reads `title`.
      id: `offer_${options.length + 1}`,
      title: optionTitle(row),
      provider: optionName(row),
      hint: sanitizeText(row.description || "", HINT_CHARS) || null,
      price_usdc: price,
      price_label: priceLabel(price),
      relevance: Number.isFinite(Number(row.relevance)) ? Number(row.relevance) : null,
      source: trimString(row.source) || null,
      external: Boolean(row.external),
      listing_slug: trimString(row.listing_slug) || null,
      input_fields: Array.isArray(row.input_fields) ? row.input_fields : [],
      // Everything apiosk_execute needs, assembled here so no surface has to
      // reconstruct it from a row it rendered.
      execute_arguments: {
        offer_token: offerToken,
        prompt: job,
        ...(price === null ? {} : { max_price_usdc: price }),
      },
    });
  }

  return {
    kind: "offer_choice",
    query: job,
    options,
    // The ranking's own pick, not the cheapest row. Re-sorting a ranked list on
    // price is how an unrelated cheap endpoint reached an approval button.
    default_id: options[0]?.id || null,
    execute_tool: "apiosk_execute",
  };
}

/** The option a caller picked, by id. Null for an id this selection never offered. */
export function findOption(selection, id) {
  const wanted = trimString(id);
  return (selection?.options || []).find((option) => option.id === wanted) || null;
}

/**
 * The fallback rendering: named lines, for a host with no picker of its own.
 *
 * Deliberately not a numbered menu — see the file header. The reply this invites
 * is "the OpenWeather one", which still means something tomorrow.
 */
export function choiceLines(selection) {
  const options = selection?.options || [];
  if (options.length === 0) return "No runnable offer came back for this job.";
  const lines = options.map((option) => {
    const tail = option.hint ? ` — ${option.hint}` : "";
    const unreviewed = option.external ? " *(unreviewed)*" : "";
    return `- **${option.provider}** · ${option.price_label}${unreviewed}${tail}`;
  });
  return [
    "Pick one to run — nothing is spent until you do:",
    ...lines,
    "",
    "Say which one you want by name, or say no and nothing is spent.",
  ].join("\n");
}
