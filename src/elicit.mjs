// The picker a host draws itself.
//
// WHY THIS EXISTS BESIDE THE HTML CARDS. src/offer-card.mjs and
// src/results-picker.mjs are real UI, and they render in hosts that implement
// MCP Apps (SEP-1865) or OpenAI's Apps SDK. Claude is not one of them for a
// server like this: interactive connectors are an approved list, and a custom
// remote connector's `ui://` resource comes back as text. What Claude Code DOES
// implement is `elicitation/create` — a request from the server that the host
// renders with its own native select and confirm.
//
// So the choice is offered twice, from one source of truth (src/selection.mjs):
// as a form here, and as HTML there. A host takes whichever it has, and a host
// with neither reads `presentation`.
//
// EVERY PATH FAILS OPEN TO PROSE. A client that never declared `elicitation`,
// one that declares it and errors, and one that takes too long all return null,
// and the caller then answers in text. An unanswered picker must never be the
// reason a read-only tool call fails.

import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildSelection, choiceLines, findOption } from "./selection.mjs";

/** A person is reading and deciding. Long enough to think, short enough to not hang a session. */
const DECISION_TIMEOUT_MS = 120_000;

/**
 * Can this session ask the person directly?
 *
 * `host` is assembled in src/create-server.mjs from the live request: the
 * client's declared capabilities plus the `sendRequest` that correlates a
 * server-initiated request with the tool call it belongs to. Absent — a test, a
 * stdio caller, the hosted server's own warm-up — there is no one to ask.
 */
export function canElicit(host) {
  return Boolean(host && typeof host.sendRequest === "function" && host.capabilities?.elicitation);
}

async function ask(host, params) {
  try {
    return await host.sendRequest({ method: "elicitation/create", params }, ElicitResultSchema, {
      timeout: DECISION_TIMEOUT_MS,
    });
  } catch {
    // Declined, cancelled, timed out, unsupported despite the capability: all
    // the same answer here, which is "fall back to text".
    return null;
  }
}

/**
 * Put the offers in front of the person and return the one they chose.
 *
 * @returns {Promise<{action: string, option: object|null}|null>} null when the
 *   host cannot ask, so the caller renders `choiceLines(selection)` instead.
 */
export async function elicitOfferChoice(host, selection) {
  const options = selection?.options || [];
  if (!canElicit(host) || options.length === 0) return null;

  const result = await ask(host, {
    mode: "form",
    message: `Which API should run this job? Nothing is spent until you pick one.\n\n${choiceLines(selection)}`,
    requestedSchema: {
      type: "object",
      required: ["offer"],
      properties: {
        offer: {
          type: "string",
          title: "Provider",
          description: "The API that runs the job, and the price that comes off your Apiosk balance.",
          // Titled options, so the row reads "OpenWeather · $0.002 · 92/100"
          // rather than "offer_1".
          oneOf: options.map((option) => ({ const: option.id, title: option.title })),
          ...(selection.default_id ? { default: selection.default_id } : {}),
        },
      },
    },
  });

  if (!result || result.action !== "accept") {
    return { action: result?.action === "decline" ? "declined" : "cancelled", option: null };
  }
  return { action: "accepted", option: findOption(selection, result.content?.offer) };
}

/**
 * The money question, asked as a question rather than as a paragraph.
 *
 * Two options and no third, because this is the one decision in the product
 * where a hedged answer costs somebody money. The price is in the label, which
 * is the rule the whole flow is built on: nobody approves a purchase whose
 * price they were not shown.
 */
export async function elicitApproval(host, { provider, priceLabel }) {
  if (!canElicit(host)) return null;

  const result = await ask(host, {
    mode: "form",
    message: `Run ${provider} for ${priceLabel}? It comes off your Apiosk balance, and nothing is spent if you deny.`,
    requestedSchema: {
      type: "object",
      required: ["decision"],
      properties: {
        decision: {
          type: "string",
          title: "This purchase",
          oneOf: [
            { const: "approve", title: `Approve · ${priceLabel}` },
            { const: "deny", title: "Deny · spend nothing" },
          ],
        },
      },
    },
  });

  if (!result || result.action !== "accept") return { decision: "denied", answered: false };
  return { decision: result.content?.decision === "approve" ? "approved" : "denied", answered: true };
}

/**
 * The one plan confirmation.
 *
 * A plan is several paid calls behind one amount, and the amount is the whole
 * of what is being agreed to — which is why this asks once, here, and why
 * apiosk_execute_plan never asks again. A second confirmation in front of a
 * plan_token would be a second question about a decision already made, and the
 * only thing it could add is a chance to answer it differently from the first.
 *
 * The shape is deliberately the same two options as `elicitApproval`: the price
 * is on the button, and there is no third answer, because this is a decision
 * that costs money and a hedge is not one of the things it can mean.
 */
export async function elicitPlanApproval(host, { question, priceLabel, calls }) {
  if (!canElicit(host)) return null;

  const scope = Number.isFinite(Number(calls)) ? `${calls} paid call${Number(calls) === 1 ? "" : "s"}` : "the planned calls";
  const result = await ask(host, {
    mode: "form",
    message: `Run this plan for at most ${priceLabel}? It covers ${scope} for "${question}", comes off your Apiosk balance, and nothing is spent if you deny.`,
    requestedSchema: {
      type: "object",
      required: ["decision"],
      properties: {
        decision: {
          type: "string",
          title: "This plan",
          oneOf: [
            { const: "approve", title: `Approve · at most ${priceLabel}` },
            { const: "deny", title: "Deny · spend nothing" },
          ],
        },
      },
    },
  });

  if (!result || result.action !== "accept") return { decision: "denied", answered: false };
  return { decision: result.content?.decision === "approve" ? "approved" : "denied", answered: true };
}

/**
 * The connect hand-off, in URL mode.
 *
 * URL mode is the shape of this step and not a stylistic choice: the buyer signs
 * in, tops up and sets the spending limits in their own account, and none of
 * that may transit the chat. The host opens the link; this server never sees a
 * password, a token or a limit.
 *
 * `elicitationId` correlates the answer with this request; the portal is what
 * finishes the flow, so a null return here just means "tell them the link".
 */
export async function elicitConnect(host, { connectUrl, elicitationId }) {
  if (!canElicit(host)) return null;
  const result = await ask(host, {
    mode: "url",
    message: "Connect Apiosk to sign in, top up and set your spending limits. Nothing is charged by connecting.",
    elicitationId,
    url: connectUrl,
  });
  return result ? { action: result.action } : null;
}

/**
 * The whole "let them choose" step, in one call, because discovery had nowhere
 * left to put it — src/discovery.mjs sits against the 20 KB line the surface
 * test holds, and what is searched and how a person is asked about it were
 * always two decisions anyway.
 *
 * Returns the three things a tool result needs: the choices as data, the answer
 * if there was one, and the sentence telling the model what to do about it.
 *
 * `enabled` is the caller's `choose` flag. An agent widening a search on its
 * own behalf must not put a modal in front of somebody who has not been asked a
 * question yet.
 */
export async function offerChoice(host, rows, { query, enabled = true, limit } = {}) {
  const selection = buildSelection(rows, { query, limit });

  if (!enabled || selection.options.length === 0) {
    return { selection, chosen: null, guidance_for_selection: NO_PICKER_GUIDANCE };
  }

  const answer = await elicitOfferChoice(host, selection);
  if (!answer) {
    return { selection, chosen: null, guidance_for_selection: NO_PICKER_GUIDANCE };
  }
  if (!answer.option) {
    return {
      selection,
      chosen: { id: null, declined: true },
      guidance_for_selection:
        "The user was shown the choices and declined. Stop. Nothing was spent, and nothing should be run.",
    };
  }

  return {
    selection,
    chosen: {
      id: answer.option.id,
      provider: answer.option.provider,
      price_usdc: answer.option.price_usdc,
      price_label: answer.option.price_label,
      execute_tool: "apiosk_execute",
      execute_arguments: answer.option.execute_arguments,
    },
    guidance_for_selection:
      "The user has already chosen, in a picker this server put in front of them. Call apiosk_execute with `chosen.execute_arguments` plus the required input values. Do not print the table and do not ask them to choose again.",
  };
}

/** What to tell a model on a host that cannot ask: offer the choice yourself, by name. */
const NO_PICKER_GUIDANCE =
  "This host has no picker of its own, so the choice is yours to offer: print `presentation`, then ask which one they want BY NAME. Never ask them to reply with a number.";
