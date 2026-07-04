export function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function extractJsonValueFromText(raw: string): unknown {
  const text = raw.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // continue
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // continue
    }
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch {
      return null;
    }
  }
  if (/^null$/i.test(text)) return null;
  return null;
}

export function extractChatCompletionText(payload: unknown): string | null {
  const root = asObject(payload);
  if (!root) return null;
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = asObject(choices[0]);
  if (!first) return null;
  const msg = asObject(first.message);
  if (!msg) return null;
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const fragments = content
      .map((item) => {
        const obj = asObject(item);
        if (!obj) return "";
        const text = obj.text;
        return typeof text === "string" ? text : "";
      })
      .filter((entry) => entry.length > 0);
    if (fragments.length > 0) return fragments.join("\n");
  }
  return null;
}

export function extractAnthropicMessageText(payload: unknown): string | null {
  const root = asObject(payload);
  if (!root) return null;
  const content = Array.isArray(root.content) ? root.content : [];
  const fragments = content
    .map((item) => {
      const obj = asObject(item);
      if (!obj) return "";
      const text = obj.text;
      return typeof text === "string" ? text : "";
    })
    .filter((entry) => entry.length > 0);
  return fragments.length > 0 ? fragments.join("\n") : null;
}
