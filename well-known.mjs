export function resolveOpenAiAppsChallengeToken(env = process.env) {
  return String(env?.APIOSK_OPENAI_APPS_CHALLENGE_TOKEN || "").trim();
}

export function sendOpenAiAppsChallenge(res, token) {
  if (!token) {
    return res.status(404).type("text/plain").send("OpenAI apps challenge token is not configured.");
  }

  return res.status(200).type("text/plain; charset=utf-8").send(token);
}
