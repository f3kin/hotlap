export interface HistoryMessage {
  id: string;
  role: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  attachments: unknown;
  context: unknown;
}

export function compareHistory(expected: HistoryMessage[], actual: HistoryMessage[]) {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
      return `{${Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
        .join(",")}}`;
    }
    return JSON.stringify(value) ?? "undefined";
  };
  const wanted = new Map(expected.map((message) => [message.id, message]));
  const found = new Map(actual.map((message) => [message.id, message]));
  const missing = expected.filter((message) => !found.has(message.id)).length;
  const extra =
    actual.filter((message) => !wanted.has(message.id)).length + actual.length - found.size;
  const changed = expected.filter(
    (message) => found.has(message.id) && canonical(message) !== canonical(found.get(message.id)),
  ).length;
  const orderChanged =
    canonical(expected.map((message) => message.id)) !==
    canonical(actual.map((message) => message.id));
  return {
    equal:
      missing === 0 &&
      extra === 0 &&
      changed === 0 &&
      !orderChanged &&
      wanted.size === expected.length,
    missing,
    extra,
    changed,
    orderChanged,
  };
}
