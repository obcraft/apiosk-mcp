import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  buildProviderKeyLabel,
  generateProviderKey,
  mintHostedProviderKey,
} from "../src/provider-key.mjs";

const ENV = {
  APIOSK_SUPABASE_URL: "https://sb.test",
  APIOSK_SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
};

function stubSupabase(handler) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method || "GET",
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    return handler(call);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("generated keys match the shape and hash verify_provider_api_key expects", () => {
  const { key, secretHash, secretPrefix } = generateProviderKey();

  // `isProviderApiKey` gates on the prefix; the portal mints 64 hex chars.
  assert.match(key, /^sk_live_[0-9a-f]{64}$/);
  // The RPC hashes the whole presented secret: encode(digest(p_secret,'sha256'),'hex').
  assert.equal(secretHash, crypto.createHash("sha256").update(key).digest("hex"));
  assert.equal(secretPrefix, key.slice(0, 16));

  // Two mints never collide.
  assert.notEqual(generateProviderKey().key, key);
});

test("labels name the connected app and stay safe as a PostgREST filter value", () => {
  assert.equal(buildProviderKeyLabel("Cursor"), "MCP - Cursor");
  assert.equal(buildProviderKeyLabel('Weird "App", v2.0'), "MCP - Weird App v20");
  assert.equal(buildProviderKeyLabel("   "), "MCP connection");
  assert.equal(buildProviderKeyLabel(undefined), "MCP connection");
});

test("minting revokes this client's previous key, then inserts the new one", async () => {
  const supabase = stubSupabase((call) =>
    call.method === "PATCH" ? jsonResponse([]) : jsonResponse([{ id: "key_1", label: "MCP - Cursor" }])
  );

  try {
    const result = await mintHostedProviderKey({
      env: ENV,
      sessionToken: "jwt_user_session",
      userId: "user_1",
      clientName: "Cursor",
    });

    assert.match(result.providerKey, /^sk_live_[0-9a-f]{64}$/);
    assert.equal(result.keyId, "key_1");
    assert.equal(result.label, "MCP - Cursor");

    assert.equal(supabase.calls.length, 2);

    const [revoke, insert] = supabase.calls;
    assert.equal(revoke.method, "PATCH");
    assert.ok(revoke.url.includes("owner_id=eq.user_1"));
    assert.ok(revoke.url.includes("revoked_at=is.null"), "only active keys are revoked");
    assert.ok(revoke.url.includes(`label=eq.${encodeURIComponent("MCP - Cursor")}`));
    assert.ok(revoke.body.revoked_at, "revocation stamps a timestamp");

    assert.equal(insert.method, "POST");
    assert.equal(insert.body.owner_id, "user_1");
    // The row is authorized by the user's own session through RLS
    // (provider_api_keys_insert_own), not by the service role.
    assert.equal(insert.headers.authorization, "Bearer jwt_user_session");
    // Only the hash and a display prefix are persisted, never the plaintext.
    assert.equal(
      insert.body.secret_hash,
      crypto.createHash("sha256").update(result.providerKey).digest("hex")
    );
    assert.equal(insert.body.secret_prefix, result.providerKey.slice(0, 16));
    assert.equal(Object.hasOwn(insert.body, "secret"), false);
  } finally {
    supabase.restore();
  }
});

test("minting is best-effort so a failure cannot break sign-in", async () => {
  const failing = stubSupabase(() => jsonResponse({ message: "permission denied" }, 403));
  try {
    assert.equal(
      await mintHostedProviderKey({
        env: ENV,
        sessionToken: "jwt_user_session",
        userId: "user_1",
        clientName: "Cursor",
      }),
      null
    );
  } finally {
    failing.restore();
  }

  // Nothing to mint against: no session, no user, or no Supabase configured.
  const untouched = stubSupabase(() => {
    throw new Error("must not call Supabase");
  });
  try {
    assert.equal(await mintHostedProviderKey({ env: ENV, userId: "user_1" }), null);
    assert.equal(await mintHostedProviderKey({ env: ENV, sessionToken: "jwt" }), null);
    assert.equal(
      await mintHostedProviderKey({ env: {}, sessionToken: "jwt", userId: "user_1" }),
      null
    );
    assert.equal(untouched.calls.length, 0);
  } finally {
    untouched.restore();
  }
});
