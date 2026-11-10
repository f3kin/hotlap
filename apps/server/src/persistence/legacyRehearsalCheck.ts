import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { LegacyBaselineMessage } from "./legacyRehearsalBaseline.ts";

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

/** Independent original-row oracle; never takes a generated import plan. */
export function compareLegacyVisibleItems(
  source: ReadonlyArray<LegacyBaselineMessage>,
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): boolean {
  return (
    items.length === source.length &&
    new Set(source.map((m) => m.message_id)).size === source.length &&
    new Set(items.map((item) => item.id)).size === items.length &&
    items.every((item, index) => {
      const row = source[index]!;
      const kind =
        row.role === "reasoning"
          ? "reasoning"
          : row.role === "user"
            ? "user_message"
            : row.role === "assistant"
              ? "assistant_message"
              : null;
      const identity =
        row.role === "reasoning"
          ? item.id === `migration:v1:turn-item:${row.message_id}`
          : "messageId" in item && item.messageId === row.message_id;
      return (
        item.type === kind &&
        identity &&
        "text" in item &&
        item.text === row.text &&
        item.threadId === row.thread_id &&
        item.ordinal === index + 1 &&
        item.status === "completed" &&
        item.startedAt !== null &&
        DateTime.formatIso(item.startedAt) === row.created_at &&
        item.completedAt !== null &&
        DateTime.formatIso(item.completedAt) === row.updated_at &&
        DateTime.formatIso(item.updatedAt) === row.updated_at &&
        item.runId === null &&
        item.nodeId === null &&
        item.providerThreadId === null &&
        item.providerTurnId === null &&
        item.nativeItemRef === null &&
        item.parentItemId === null &&
        (!("streaming" in item) || item.streaming === false)
      );
    })
  );
}
