import test from "node:test";
import assert from "node:assert/strict";

import { buildDiscoveryDocument, clearPublisherCaches } from "../src/publisher.mjs";

const GATEWAY = "https://gateway.apiosk.com";

function item(slug) {
  return {
    resource: `${GATEWAY}/${slug}/v1/thing`,
    x402Version: 2,
    accepts: [{ amount: "10000", network: "eip155:8453", payTo: "0xPLATFORM" }],
    metadata: { api: slug, name: `${slug} API`, method: "GET" },
  };
}

/** A gateway serving `total` resources, paginated the way the real one is. */
function pagedGateway(total, perPageCap = 100) {
  const calls = [];
  const all = Array.from({ length: total }, (_, index) => item(`api-${index}`));

  const fetchImpl = async (url) => {
    calls.push(url);
    const parsed = new URL(url);
    const perPage = Math.min(
      Number.parseInt(parsed.searchParams.get("perPage") || "15", 10),
      perPageCap
    );
    const page = Number.parseInt(parsed.searchParams.get("page") || "1", 10);
    const totalPages = Math.max(Math.ceil(all.length / perPage), 1);
    const items = all.slice((page - 1) * perPage, page * perPage);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        x402Version: 2,
        items,
        pagination: { page, perPage, totalPages, matchedResources: all.length },
        links:
          page < totalPages
            ? { next: `${GATEWAY}/.well-known/x402?page=${page + 1}&perPage=${perPage}` }
            : {},
      }),
    };
  };

  return { fetchImpl, calls };
}

test("discovery index walks every page, not just the first", async () => {
  clearPublisherCaches();
  const { fetchImpl, calls } = pagedGateway(250);

  const document = await buildDiscoveryDocument({ env: {}, fetchImpl });

  assert.equal(document.count, 250, "an index of 'every paid route' must not stop at page one");
  assert.equal(document.routes.length, 250);
  assert.equal(calls.length, 3, "250 resources at the 100 cap is three requests");
  assert.match(calls[0], /perPage=100/, "asks for the largest page the gateway allows");
  assert.equal(document.routes[0].url, `${GATEWAY}/api-0/v1/thing`);
  assert.equal(document.routes.at(-1).url, `${GATEWAY}/api-249/v1/thing`);
});

test("a single-page document is complete without a next link", async () => {
  clearPublisherCaches();
  const { fetchImpl, calls } = pagedGateway(12);

  const document = await buildDiscoveryDocument({ env: {}, fetchImpl });

  assert.equal(document.count, 12);
  assert.equal(calls.length, 1);
});

test("a gateway that always advertises a next page cannot loop forever", async () => {
  clearPublisherCaches();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        items: [item(`api-${calls}`)],
        // Buggy gateway: never stops.
        links: { next: `${GATEWAY}/.well-known/x402?page=${calls + 1}` },
      }),
    };
  };

  const document = await buildDiscoveryDocument({ env: {}, fetchImpl });

  assert.equal(calls, 50, "the walk is bounded");
  assert.equal(document.count, 50);
});

test("an unreachable gateway fails loudly rather than indexing a partial catalog", async () => {
  clearPublisherCaches();
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });

  await assert.rejects(
    () => buildDiscoveryDocument({ env: {}, fetchImpl }),
    /HTTP 503/
  );
});
