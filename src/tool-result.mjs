// One shape for every tool result.
//
// `structuredContent` is what a client can act on; the text block is what a
// model reads when the client has no structured channel. Both are always
// present, and they are always the same object, so an agent never has to guess
// which one is authoritative.

export function content(value) {
  const result = {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    result.structuredContent = value;
  }
  return result;
}

export function errorContent(value) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    isError: true,
  };
}

export function trimString(value) {
  return String(value ?? "").trim();
}
