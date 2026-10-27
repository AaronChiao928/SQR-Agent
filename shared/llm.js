// Shared: minimal client for the Anthropic Messages API, with no dependencies.
// It exposes the same `client.messages.create(...)` shape as the official SDK,
// so code written against it works with either, and tests can pass in a fake client.

export function createClient({ apiKey, baseUrl = "https://api.anthropic.com", fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set (see .env.example).");
  return {
    messages: {
      async create(body) {
        const res = await fetchImpl(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(`Messages API error ${res.status}: ${data?.error?.message || JSON.stringify(data)}`);
        return data;
      },
    },
  };
}

/** The text of a Messages API response. */
export const responseText = (res) => (res?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");

/** Read a JSON value from model text: the whole text, a ```json fence, or first { to last }. */
export function parseJson(text) {
  const t = String(text ?? "");
  const tries = [t, (t.match(/```(?:json)?\s*([\s\S]*?)```/) || [])[1], t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)];
  for (const x of tries) {
    if (!x) continue;
    try { return JSON.parse(x); } catch { /* try the next form */ }
  }
  throw new Error("The model's answer was not valid JSON: " + t.slice(0, 300));
}
