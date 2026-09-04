// The component the buyer actually touches: the choice, and the card.
//
// Three things are asserted here and each one broke something real before:
//
//   an option a person can pick has to be one apiosk_execute can run, so a row
//   with no offer_token never reaches a picker;
//
//   a host that cannot ask must still answer, so every elicitation path failing
//   open to prose is a test rather than a comment;
//
//   provider text is untrusted, so the cards put it on the page through
//   textContent and never through innerHTML.

import test from "node:test";
import assert from "node:assert/strict";

import { buildSelection, choiceLines, findOption, optionTitle } from "../src/selection.mjs";
import { canElicit, offerChoice } from "../src/elicit.mjs";
import { runQuickBest } from "../src/tools/top.mjs";
import { APIO_RESULTS_PICKER_HTML, APIO_RESULTS_PICKER_URI } from "../src/results-picker.mjs";
import { APIO_CONNECT_CARD_HTML, APIO_CONNECT_CARD_URI } from "../src/connect-card.mjs";
import { APIOSK_UI_BRIDGE } from "../src/ui-bridge.mjs";

const ROWS = [
  {
    name: "OpenWeather",
    listing_slug: "current-weather",
    price_usdc: 0.002,
    relevance: 92,
    source: "apiosk",
    offer_token: "tok-weather",
    description: "Current conditions for a city.",
    input_fields: [{ name: "city", required: true, type: "string", location: "query" }],
  },
  {
    name: "Meteo",
    listing_slug: "meteo",
    price_usdc: 0.0015,
    relevance: 71,
    source: "x402",
    external: true,
    offer_token: "tok-meteo",
  },
  // Priced by nobody: the gateway minted no token, so it cannot be run.
  { name: "Unrunnable", listing_slug: "nope", price_usdc: 0.001, offer_token: "" },
];

/** A client that declared `elicitation` and answers with `answer`. */
function hostThatAnswers(answer, seen = []) {
  return {
    capabilities: { elicitation: {} },
    sendRequest: async (message) => {
      seen.push(message);
      return answer;
    },
  };
}

test("only a runnable row becomes an option, and its label carries the one price", () => {
  const selection = buildSelection(ROWS, { query: "weather in Rotterdam" });

  assert.deepEqual(
    selection.options.map((option) => option.provider),
    ["OpenWeather (current-weather)", "Meteo"],
    "a row with no offer_token is a dead end with a price on it"
  );
  assert.equal(selection.options[0].price_label, "$0.002");
  assert.equal(selection.default_id, "offer_1", "the ranking's pick, not the cheapest row");
  assert.equal(selection.options[0].execute_arguments.offer_token, "tok-weather");
  assert.equal(selection.options[0].execute_arguments.prompt, "weather in Rotterdam");
  assert.equal(findOption(selection, "offer_2").provider, "Meteo");
  assert.equal(findOption(selection, "offer_9"), null);
});

test("a label names the listing when the publisher's name does not", () => {
  assert.equal(
    optionTitle({ name: "Apiosk Basics", listing_slug: "fx-rates", price_usdc: 0.01 }),
    "Apiosk Basics (fx-rates) · $0.01"
  );
  assert.equal(optionTitle({ name: "OpenWeather", listing_slug: "openweather", price_usdc: 0.002 }), "OpenWeather · $0.002");
});

test("the prose fallback asks by name and never by number", () => {
  const lines = choiceLines(buildSelection(ROWS, { query: "weather" }));
  assert.match(lines, /\*\*OpenWeather \(current-weather\)\*\* · \$0\.002/);
  assert.match(lines, /by name/);
  assert.doesNotMatch(lines, /Reply 1|reply with a number|^\s*1\./m);
});

test("a host with no elicitation is never asked, and still gets an answer", async () => {
  assert.equal(canElicit(null), false);
  assert.equal(canElicit({ sendRequest: () => {}, capabilities: {} }), false);

  const { chosen, guidance_for_selection } = await offerChoice(null, ROWS, { query: "weather" });
  assert.equal(chosen, null);
  assert.match(guidance_for_selection, /BY NAME/);
});

test("the picker is a titled single-select, and the answer comes back ready to run", async () => {
  const seen = [];
  const host = hostThatAnswers({ action: "accept", content: { offer: "offer_2" } }, seen);
  const { chosen } = await offerChoice(host, ROWS, { query: "weather" });

  assert.equal(seen[0].method, "elicitation/create");
  assert.equal(seen[0].params.mode, "form");
  assert.deepEqual(
    seen[0].params.requestedSchema.properties.offer.oneOf.map((option) => option.title),
    ["OpenWeather (current-weather) · $0.002 · 92/100", "Meteo · $0.0015 · 71/100"]
  );
  assert.equal(chosen.provider, "Meteo");
  assert.equal(chosen.execute_tool, "apiosk_execute");
  assert.equal(chosen.execute_arguments.offer_token, "tok-meteo");
});

test("declining the picker is an answer, and it says stop", async () => {
  const { chosen, guidance_for_selection } = await offerChoice(hostThatAnswers({ action: "decline" }), ROWS, {
    query: "weather",
  });
  assert.deepEqual(chosen, { id: null, declined: true });
  assert.match(guidance_for_selection, /Stop\./);
});

test("choose:false leaves the person alone", async () => {
  const seen = [];
  const { chosen } = await offerChoice(hostThatAnswers({ action: "accept" }, seen), ROWS, {
    query: "weather",
    enabled: false,
  });
  assert.equal(seen.length, 0, "an exploratory sweep must not open a modal");
  assert.equal(chosen, null);
});

test("a denied purchase never reports itself as ok", async () => {
  const gateway = {
    requestJson: async () => ({
      answers_job: true,
      pick: {
        offer: { kind: "reviewed", source: "apiosk", api_slug: "finnhub", name: "Finnhub", resource_url: null },
        name: "Finnhub",
        price_usd: 0.05,
        offer_token: "finn-token",
      },
      results: [],
    }),
  };

  const seen = [];
  const denied = JSON.parse(
    (
      await runQuickBest(
        { query: "price of AAPL" },
        { gateway, host: hostThatAnswers({ action: "accept", content: { decision: "deny" } }, seen) }
      )
    ).content[0].text
  );
  assert.equal(denied.status, "denied");
  assert.match(seen[0].params.requestedSchema.properties.decision.oneOf[0].title, /Approve · \$0\.05/);

  const approved = JSON.parse(
    (
      await runQuickBest(
        { query: "price of AAPL" },
        { gateway, host: hostThatAnswers({ action: "accept", content: { decision: "approve" } }) }
      )
    ).content[0].text
  );
  assert.equal(approved.status, "approved");
  assert.equal(approved.approval.state, "approved_by_user");
});

test("the cards speak both host protocols and render provider text as text", () => {
  for (const html of [APIO_RESULTS_PICKER_HTML, APIO_CONNECT_CARD_HTML]) {
    assert.ok(html.includes(APIOSK_UI_BRIDGE), "every card embeds the one bridge");
    assert.doesNotMatch(html, /innerHTML/, "provider text goes in through textContent");
  }
  // Both transports, from one document.
  assert.match(APIOSK_UI_BRIDGE, /ui\/initialize/);
  assert.match(APIOSK_UI_BRIDGE, /ui\/notifications\/tool-result/);
  assert.match(APIOSK_UI_BRIDGE, /window\.openai/);

  assert.equal(APIO_RESULTS_PICKER_URI, "ui://apiosk/results-picker.html");
  assert.equal(APIO_CONNECT_CARD_URI, "ui://apiosk/connect-card.html");
  assert.match(APIO_RESULTS_PICKER_HTML, /apiosk_execute/);
  assert.match(APIO_CONNECT_CARD_HTML, /apiosk_connect/);
});
