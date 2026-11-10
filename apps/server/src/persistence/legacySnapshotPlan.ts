import { EventId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import type { LegacyBaselineThread, LegacyBaselineMessage } from "./legacyRehearsalBaseline.ts";
import {
  fingerprint,
  makeSandboxPlan,
  MAX_SANDBOX_EVENTS,
  MAX_SANDBOX_PLAN_BYTES,
  type SandboxPlan,
} from "./SandboxHistoryImport.ts";
import * as DateTime from "effect/DateTime";
import { compareHistory } from "./legacyRehearsalCheck.ts";
export interface SnapshotInput {
  thread: LegacyBaselineThread;
  sourceLifecycle: {
    forkSourceThreadId: string | null;
    forkSourceMessageId: string | null;
    archivedAt: string | null;
    deletedAt: string | null;
  };
  messages: LegacyBaselineMessage[];
  staged: ReadonlyArray<OrchestrationV2DomainEvent>;
  sourceSnapshotSha256: string;
  targetBaselineSequence: number;
}
// Reconstruct final projected transcript state, never replay a source event ledger.
export function buildLegacySnapshotPlan(
  input: SnapshotInput,
): { plan: SandboxPlan } | { refused: string } {
  if (
    input.sourceLifecycle.forkSourceThreadId !== null ||
    input.sourceLifecycle.forkSourceMessageId !== null
  )
    return { refused: "source_fork_excluded" };
  if (input.staged.length > MAX_SANDBOX_EVENTS) return { refused: "event_limit" };
  if (input.messages.some((m) => !["user", "assistant"].includes(m.role) || m.is_streaming !== 0))
    return { refused: "unsupported_role_or_streaming" };
  if (new TextEncoder().encode(JSON.stringify(input.staged)).byteLength > MAX_SANDBOX_PLAN_BYTES)
    return { refused: "byte_limit" };
  const messages = input.staged.filter((e) => e.type === "message.updated");
  const items = input.staged.filter((e) => e.type === "turn-item.updated");
  if (
    new Set(messages.map((e) => e.payload.id)).size !== messages.length ||
    new Set(items.map((e) => e.payload.id)).size !== items.length
  )
    return { refused: "duplicate_entity_update" };
  const sourceOrder = new Map(input.messages.map((message, index) => [message.message_id, index]));
  messages.sort(
    (a, b) => (sourceOrder.get(a.payload.id) ?? -1) - (sourceOrder.get(b.payload.id) ?? -1),
  );
  items.sort((a, b) => {
    const left = "messageId" in a.payload ? sourceOrder.get(a.payload.messageId) : undefined;
    const right = "messageId" in b.payload ? sourceOrder.get(b.payload.messageId) : undefined;
    return (left ?? -1) - (right ?? -1);
  });
  const shells = input.staged.filter((e) => e.type === "thread.created");
  const metadata = input.staged.filter((e) => e.type === "thread.metadata-updated");
  const first = shells[0];
  if (
    shells.length !== 1 ||
    metadata.length !== 1 ||
    !first ||
    input.staged.length !== 2 + messages.length + items.length ||
    items.length !== messages.length
  )
    return { refused: "unsupported_event_shape" };
  const row = input.thread;
  const t = first.payload;
  const iso = (value: string) => DateTime.formatIso(DateTime.makeUnsafe(value));
  if (
    input.staged.some((e) => e.threadId !== row.thread_id) ||
    t.id !== row.thread_id ||
    t.projectId !== row.project_id ||
    t.title !== row.title ||
    t.branch !== row.branch ||
    t.worktreePath !== row.worktree_path ||
    DateTime.formatIso(t.createdAt) !== iso(row.created_at) ||
    t.lineage.parentThreadId !== null ||
    t.forkedFrom !== null
  )
    return { refused: "source_thread_metadata_mismatch" };
  if (
    (t.archivedAt === null ? null : DateTime.formatIso(t.archivedAt)) !==
      (input.sourceLifecycle.archivedAt === null ? null : iso(input.sourceLifecycle.archivedAt)) ||
    (t.deletedAt === null ? null : DateTime.formatIso(t.deletedAt)) !==
      (input.sourceLifecycle.deletedAt === null ? null : iso(input.sourceLifecycle.deletedAt))
  )
    return { refused: "source_lifecycle_mismatch" };
  try {
    const expected = input.messages.map((m) => ({
      id: m.message_id,
      role: m.role,
      text: m.text,
      createdAt: iso(m.created_at),
      updatedAt: iso(m.updated_at),
      attachments: JSON.parse(m.attachments_json ?? "[]"),
      context: JSON.parse(m.context_json ?? "null"),
    }));
    const actual = messages.map(({ payload: m }) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      createdAt: DateTime.formatIso(m.createdAt),
      updatedAt: DateTime.formatIso(m.updatedAt),
      attachments: m.attachments,
      context: m.context ?? null,
    }));
    if (!compareHistory(expected, actual).equal) return { refused: "source_history_mismatch" };
  } catch {
    return { refused: "invalid_source_values" };
  }
  for (const [index, event] of items.entries()) {
    const item = event.payload;
    const message = messages[index]?.payload;
    if (
      !message ||
      (item.type !== "user_message" && item.type !== "assistant_message") ||
      item.messageId !== message.id ||
      item.text !== message.text ||
      (message.role === "user"
        ? item.type !== "user_message"
        : item.type !== "assistant_message") ||
      item.ordinal !== index + 1 ||
      item.status !== "completed" ||
      item.startedAt === null ||
      item.completedAt === null ||
      DateTime.formatIso(item.startedAt) !== input.messages[index]?.created_at ||
      DateTime.formatIso(item.completedAt) !== input.messages[index]?.updated_at ||
      DateTime.formatIso(item.updatedAt) !== DateTime.formatIso(message.updatedAt) ||
      fingerprint("context" in item ? (item.context ?? null) : null) !==
        fingerprint(message.context ?? null) ||
      (item.type === "user_message" &&
        fingerprint(item.attachments) !== fingerprint(message.attachments)) ||
      item.runId !== null ||
      item.nodeId !== null ||
      item.parentItemId !== null ||
      message.streaming !== false ||
      message.runId !== null ||
      message.nodeId !== null
    )
      return { refused: "unsupported_turn_item" };
  }
  const final = { ...t, updatedAt: DateTime.makeUnsafe(row.updated_at) };
  const events: OrchestrationV2DomainEvent[] = [
    first,
    ...messages.flatMap((message, index) => [message, items[index]!]),
    {
      id: EventId.make(`snapshot-final:${row.thread_id}`),
      threadId: first.threadId,
      type: "thread.metadata-updated",
      occurredAt: final.updatedAt,
      payload: final,
    },
  ];
  return {
    plan: makeSandboxPlan({
      sourceSnapshotSha256: input.sourceSnapshotSha256,
      sourceThreadId: row.thread_id,
      targetThreadId: first.threadId,
      targetProjectId: t.projectId,
      targetBaselineSequence: input.targetBaselineSequence,
      events,
    }),
  };
}
