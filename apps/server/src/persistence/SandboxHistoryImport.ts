// Offline fixture integration only; never attach to a running server database.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Pure offline manifest construction uses a synchronous digest without a runtime service.
import * as NodeCrypto from "node:crypto";
import {
  EventId,
  OrchestrationV2DomainEvent,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";

export const MAX_SANDBOX_EVENTS = 2000;
export const MAX_SANDBOX_PLAN_BYTES = 4 * 1024 * 1024;

export interface SandboxPlanInput {
  sourceSnapshotSha256: string;
  sourceThreadId: string;
  targetThreadId: ThreadId;
  targetProjectId: ProjectId;
  targetBaselineSequence: number;
  events: ReadonlyArray<OrchestrationV2DomainEvent>;
}
export interface SandboxPlan extends SandboxPlanInput {
  schema: 1;
  digest: string;
  sourceEventIds: string[];
}

export function fingerprint(value: unknown): string {
  const normalise = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(normalise)
      : item !== null && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, normalise(entry)]),
          )
        : item;
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify(normalise(JSON.parse(JSON.stringify(value)))))
    .digest("hex");
}
function manifest(input: SandboxPlanInput, sourceEventIds: string[]) {
  return {
    sourceSnapshotSha256: input.sourceSnapshotSha256,
    sourceThreadId: input.sourceThreadId,
    targetThreadId: input.targetThreadId,
    targetProjectId: input.targetProjectId,
    targetBaselineSequence: input.targetBaselineSequence,
    events: input.events.map(({ id: _id, ...event }) => event),
    sourceEventIds,
  };
}
export function makeSandboxPlan(input: SandboxPlanInput): SandboxPlan {
  const sourceEventIds = input.events.map((event) => event.id);
  const digest = fingerprint(manifest(input, sourceEventIds));
  return {
    ...input,
    schema: 1,
    sourceEventIds,
    digest,
    events: input.events.map((event, index) => ({
      ...event,
      id: EventId.make(`sandbox-recovery:${digest}:${index}`),
    })),
  };
}
export class SandboxImportRefused extends Schema.TaggedError<SandboxImportRefused>()(
  "SandboxImportRefused",
  { reason: Schema.String },
) {}

// The outer transaction is safe only offline: EventSink publications must have no subscribers.
const decodeEvent = Schema.decodeEffect(OrchestrationV2DomainEvent);
const encodePlan = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const applySandboxPlan = Effect.fn("SandboxHistoryImport.applySandboxPlan")(function* (
  plan: SandboxPlan,
) {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* EventStore.EventStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const refuse = (reason: string) => Effect.fail(new SandboxImportRefused({ reason }));
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (
        plan.schema !== 1 ||
        !/^[a-f0-9]{64}$/.test(plan.sourceSnapshotSha256) ||
        !plan.sourceThreadId ||
        !Number.isSafeInteger(plan.targetBaselineSequence) ||
        plan.targetBaselineSequence < 0 ||
        plan.events.length < 2 ||
        plan.events.length > MAX_SANDBOX_EVENTS ||
        new TextEncoder().encode(encodePlan(plan)).byteLength > MAX_SANDBOX_PLAN_BYTES ||
        plan.sourceEventIds.length !== plan.events.length ||
        new Set(plan.sourceEventIds).size !== plan.events.length ||
        fingerprint(manifest(plan, plan.sourceEventIds)) !== plan.digest
      )
        return yield* refuse("invalid manifest or digest");
      for (const [index, event] of plan.events.entries()) {
        yield* decodeEvent(event);
        if (
          event.id !== `sandbox-recovery:${plan.digest}:${index}` ||
          event.threadId !== plan.targetThreadId ||
          ![
            "thread.created",
            "thread.metadata-updated",
            "message.updated",
            "turn-item.updated",
          ].includes(event.type)
        )
          return yield* refuse("unsupported event or mapping");
        if (
          (event.type === "thread.created" || event.type === "thread.metadata-updated") &&
          (event.payload.id !== plan.targetThreadId ||
            event.payload.projectId !== plan.targetProjectId)
        )
          return yield* refuse("thread mapping mismatch");
        if (
          (event.type === "message.updated" || event.type === "turn-item.updated") &&
          event.payload.threadId !== plan.targetThreadId
        )
          return yield* refuse("entity mapping mismatch");
      }
      const last = plan.events.at(-1)!;
      if (
        plan.events[0]?.type !== "thread.created" ||
        last.type !== "thread.metadata-updated" ||
        plan.events.filter((e) => e.type === "thread.created").length !== 1 ||
        plan.events.filter((e) => e.type === "thread.metadata-updated").length !== 1
      )
        return yield* refuse("requires one complete thread and final metadata");
      const checkProjection = Effect.gen(function* () {
        const actual = yield* projections.getThreadProjection(plan.targetThreadId);
        if (fingerprint(actual.thread) !== fingerprint(last.payload))
          return yield* refuse("thread projection differs");
        for (const [kind, table] of [
          ["message.updated", "orchestration_v2_projection_messages"],
          ["turn-item.updated", "orchestration_v2_projection_turn_items"],
        ] as const) {
          const expected = plan.events
            .filter((e) => e.type === kind)
            .map((e) => fingerprint(e.payload))
            .sort();
          const rows = yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM ${sql(table)} WHERE thread_id = ${plan.targetThreadId}`;
          if (
            fingerprint(rows.map((row) => fingerprint(JSON.parse(row.payload_json))).sort()) !==
            fingerprint(expected)
          )
            return yield* refuse("history projection differs");
        }
      });
      const existing = yield* store
        .read({ threadId: plan.targetThreadId, limit: MAX_SANDBOX_EVENTS + 1 })
        .pipe(Stream.runCollect);
      const rows =
        yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${plan.targetThreadId}`;
      if (rows.length || existing.length) {
        if (fingerprint(existing.map((row) => row.event)) !== fingerprint(plan.events))
          return yield* refuse("existing or partial thread conflicts");
        yield* checkProjection;
        return { status: "already_exact" as const, eventsWritten: 0 };
      }
      if ((yield* store.latestApplicationSequence) !== plan.targetBaselineSequence)
        return yield* refuse("target baseline changed");
      for (const event of plan.events) {
        if (event.type === "message.updated") {
          if (
            (yield* sql`SELECT message_id FROM orchestration_v2_projection_messages WHERE message_id = ${event.payload.id}`)
              .length
          )
            return yield* refuse("message identity collision");
        } else if (event.type === "turn-item.updated") {
          if (
            (yield* sql`SELECT turn_item_id FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ${event.payload.id}`)
              .length
          )
            return yield* refuse("turn item identity collision");
        }
      }
      yield* sink.write({ events: plan.events });
      yield* checkProjection;
      return { status: "applied" as const, eventsWritten: plan.events.length };
    }),
  );
});
