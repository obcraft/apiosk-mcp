import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveOpenAiAppsChallengeToken,
  sendOpenAiAppsChallenge,
} from "../well-known.mjs";

function createMockResponse() {
  return {
    statusCode: 200,
    contentType: null,
    body: null,
    status(value) {
      this.statusCode = value;
      return this;
    },
    type(value) {
      this.contentType = value;
      return this;
    },
    send(value) {
      this.body = value;
      return this;
    },
  };
}

test("resolveOpenAiAppsChallengeToken trims configured values", () => {
  assert.equal(
    resolveOpenAiAppsChallengeToken({
      APIOSK_OPENAI_APPS_CHALLENGE_TOKEN: "  token_123  ",
    }),
    "token_123"
  );
  assert.equal(resolveOpenAiAppsChallengeToken({}), "");
});

test("sendOpenAiAppsChallenge returns plaintext token when configured", () => {
  const response = createMockResponse();

  sendOpenAiAppsChallenge(response, "token_123");

  assert.equal(response.statusCode, 200);
  assert.equal(response.contentType, "text/plain; charset=utf-8");
  assert.equal(response.body, "token_123");
});

test("sendOpenAiAppsChallenge returns 404 when token is missing", () => {
  const response = createMockResponse();

  sendOpenAiAppsChallenge(response, "");

  assert.equal(response.statusCode, 404);
  assert.equal(response.contentType, "text/plain");
  assert.match(response.body, /not configured/i);
});
