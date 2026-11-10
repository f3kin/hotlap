// @effect-diagnostics nodeBuiltinImport:off
// Sandbox-only original-to-populated-target proof; no app/provider runtime.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "node:crypto";
import { OrchestrationV2DomainEventJson, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Persistence from "../src/persistence/Sqlite.ts";
import * as EventStore from "../src/orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../src/orchestration-v2/EventSink.ts";
import * as Legacy from "../src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import { captureLegacyBaseline } from "../src/persistence/legacyRehearsalBaseline.ts";
import { compareHistory } from "../src/persistence/legacyRehearsalCheck.ts";
import { buildLegacySnapshotPlan } from "../src/persistence/legacySnapshotPlan.ts";
import { applySandboxPlan, fingerprint } from "../src/persistence/SandboxHistoryImport.ts";
const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson);
const pins = JSON.parse(NodeFS.readFileSync("/pins.json", "utf8")) as Record<string, string>;
const hashes = () =>
  Object.fromEntries(
    ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm"].map((name) => [
      name,
      NodeCrypto.createHash("sha256")
        .update(NodeFS.readFileSync(`/input/${name}`))
        .digest("hex"),
    ]),
  );
if (fingerprint(hashes()) !== fingerprint(pins)) throw new Error("source_hash_mismatch");
const input = new NodeSqlite.DatabaseSync("/input/state.sqlite", { readOnly: true });
const baseline = captureLegacyBaseline(input);
const categories = Object.fromEntries(
  [
    "orchestration_events",
    "projection_thread_activities",
    "projection_turns",
    "projection_thread_sessions",
    "projection_thread_proposed_plans",
    "projection_thread_pull_requests",
  ].map((table) => [table, Number(input.prepare(`SELECT count(*) n FROM ${table}`).get()?.n)]),
);
const forkCount = Number(
  input
    .prepare(
      "SELECT count(*) n FROM projection_threads WHERE fork_source_thread_id IS NOT NULL OR fork_source_message_id IS NOT NULL",
    )
    .get()?.n,
);
const lifecycles = new Map(
  input
    .prepare(
      "SELECT thread_id,fork_source_thread_id,fork_source_message_id,archived_at,deleted_at FROM projection_threads",
    )
    .all()
    .map((row) => [
      String(row.thread_id),
      {
        forkSourceThreadId: row.fork_source_thread_id as string | null,
        forkSourceMessageId: row.fork_source_message_id as string | null,
        archivedAt: row.archived_at as string | null,
        deletedAt: row.deleted_at as string | null,
      },
    ]),
);
input.close();
const staging = new NodeSqlite.DatabaseSync("/scratch/userdata/statev2.sqlite", { readOnly: true });
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(Persistence.layerMemory),
);
const sink = EventSink.layer.pipe(Layer.provide(stores));
const layers = Layer.mergeAll(
  stores,
  sink,
  Legacy.layer.pipe(Layer.provide(Layer.mergeAll(stores, sink))),
);
const result = {
  kind: "synthetic_populated_snapshot_translation",
  sourceThreads: baseline.threads.length,
  sourceMessages: baseline.messages.length,
  appliedThreads: 0,
  appliedMessages: 0,
  refused: [] as { threadId: string; reason: string; messages: number; events: number }[],
  mapping: [] as {
    sourceThreadId: string;
    targetThreadId: string;
    projectId: string;
    planDigest: string;
  }[],
  sourceUnchanged: false,
  unrelatedUnchanged: false,
  projectionMismatches: 0,
  finalProjectionDrift: 0,
  fixtureRowsUnchanged: false,
  orphanMessages: baseline.messages.filter(
    (m) => !baseline.threads.some((t) => t.thread_id === m.thread_id),
  ).length,
  allSourceAccounted: false,
  visibleItemMismatches: 0,
  lifecycleMismatches: 0,
  metadataMismatches: 0,
  replayWrites: 0,
  attachmentReferences: 0,
  sourceCategories: categories,
  sourceForkReferences: forkCount,
  failure: null as string | null,
};
try {
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const legacy = yield* Legacy.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* EventStore.EventStoreV2;
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('unrelated-project','Fixture','/fixture','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,created_at,updated_at) VALUES('unrelated-thread','unrelated-project','Keep fixture','{"instanceId":"codex","model":"gpt-5.4"}','full-access','default','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
      yield* legacy.reconcileShells;
      const unrelated = fingerprint(
        yield* projections.getThreadProjection(ThreadId.make("unrelated-thread")),
      );
      for (const project of new Set(baseline.threads.map((t) => t.project_id)))
        yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES(${project},'Synthetic mapping','/fixture','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
      const importedFingerprints = new Map<string, string>();
      const fixtureRows = Effect.gen(function* () {
        return fingerprint({
          projects: yield* sql`SELECT * FROM projection_projects ORDER BY project_id`,
          legacyThreads: yield* sql`SELECT * FROM projection_threads ORDER BY thread_id`,
          legacyMessages: yield* sql`SELECT * FROM projection_thread_messages ORDER BY message_id`,
        });
      });
      const beforeFixtureRows = yield* fixtureRows;
      for (const thread of baseline.threads) {
        const messages = baseline.messages.filter((m) => m.thread_id === thread.thread_id);
        const raw = staging
          .prepare(
            "SELECT event_id,stream_id,event_type,occurred_at,payload_json FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread' AND stream_id=? ORDER BY sequence",
          )
          .all(thread.thread_id);
        const staged = raw.map((row) =>
          decodeEvent({
            id: row.event_id,
            threadId: row.stream_id,
            type: row.event_type,
            occurredAt: row.occurred_at,
            payload: JSON.parse(String(row.payload_json)),
          }),
        );
        const built = buildLegacySnapshotPlan({
          thread,
          sourceLifecycle: lifecycles.get(thread.thread_id)!,
          messages,
          staged,
          sourceSnapshotSha256: fingerprint(pins),
          targetBaselineSequence: yield* events.latestApplicationSequence,
        });
        if ("refused" in built) {
          result.refused.push({
            threadId: thread.thread_id,
            reason: built.refused,
            messages: messages.length,
            events: staged.length,
          });
          continue;
        }
        yield* applySandboxPlan(built.plan);
        result.appliedThreads++;
        result.appliedMessages += messages.length;
        result.mapping.push({
          sourceThreadId: thread.thread_id,
          targetThreadId: built.plan.targetThreadId,
          projectId: built.plan.targetProjectId,
          planDigest: built.plan.digest,
        });
        const actual = yield* projections.getThreadProjection(ThreadId.make(thread.thread_id));
        importedFingerprints.set(thread.thread_id, fingerprint(actual));
        const expected = messages.map((m) => ({
          id: m.message_id,
          role: m.role,
          text: m.text,
          createdAt: DateTime.formatIso(DateTime.makeUnsafe(m.created_at)),
          updatedAt: DateTime.formatIso(DateTime.makeUnsafe(m.updated_at)),
          attachments: JSON.parse(m.attachments_json ?? "[]"),
          context: JSON.parse(m.context_json ?? "null"),
        }));
        result.attachmentReferences += expected.reduce(
          (n, m) => n + (Array.isArray(m.attachments) ? m.attachments.length : 0),
          0,
        );
        if (
          !compareHistory(
            expected,
            actual.messages.map((m) => ({
              id: m.id,
              role: m.role,
              text: m.text,
              createdAt: DateTime.formatIso(m.createdAt),
              updatedAt: DateTime.formatIso(m.updatedAt),
              attachments: m.attachments,
              context: m.context ?? null,
            })),
          ).equal
        )
          result.projectionMismatches++;
        if (
          actual.thread.id !== thread.thread_id ||
          actual.thread.projectId !== thread.project_id ||
          actual.thread.title !== thread.title ||
          actual.thread.branch !== thread.branch ||
          actual.thread.worktreePath !== thread.worktree_path ||
          DateTime.formatIso(actual.thread.createdAt) !==
            DateTime.formatIso(DateTime.makeUnsafe(thread.created_at)) ||
          DateTime.formatIso(actual.thread.updatedAt) !==
            DateTime.formatIso(DateTime.makeUnsafe(thread.updated_at))
        )
          result.metadataMismatches++;
        const sourceLifecycle = lifecycles.get(thread.thread_id)!;
        const nullableIso = (value: string | null) =>
          value === null ? null : DateTime.formatIso(DateTime.makeUnsafe(value));
        if (
          (actual.thread.archivedAt === null
            ? null
            : DateTime.formatIso(actual.thread.archivedAt)) !==
            nullableIso(sourceLifecycle.archivedAt) ||
          (actual.thread.deletedAt === null
            ? null
            : DateTime.formatIso(actual.thread.deletedAt)) !==
            nullableIso(sourceLifecycle.deletedAt)
        )
          result.lifecycleMismatches++;
        const visible = actual.visibleTurnItems.map((row) => row.item);
        if (
          visible.length !== messages.length ||
          visible.some((item, index) => {
            const message = messages[index]!;
            return (
              (item.type !== "user_message" && item.type !== "assistant_message") ||
              item.messageId !== message.message_id ||
              item.text !== message.text ||
              item.type !== (message.role === "user" ? "user_message" : "assistant_message") ||
              item.ordinal !== index + 1 ||
              item.startedAt === null ||
              item.completedAt === null ||
              DateTime.formatIso(item.startedAt) !== message.created_at ||
              DateTime.formatIso(item.completedAt) !== message.updated_at ||
              DateTime.formatIso(item.updatedAt) !== message.updated_at
            );
          })
        )
          result.visibleItemMismatches++;
        const before = yield* events.latestApplicationSequence;
        yield* applySandboxPlan(built.plan);
        result.replayWrites += (yield* events.latestApplicationSequence) - before;
      }
      for (const [id, expected] of importedFingerprints)
        if (fingerprint(yield* projections.getThreadProjection(ThreadId.make(id))) !== expected)
          result.finalProjectionDrift++;
      result.fixtureRowsUnchanged = (yield* fixtureRows) === beforeFixtureRows;
      result.unrelatedUnchanged =
        unrelated ===
        fingerprint(yield* projections.getThreadProjection(ThreadId.make("unrelated-thread")));
    }).pipe(Effect.provide(layers)),
  );
} catch {
  result.failure = "translation_or_target_refused";
} finally {
  staging.close();
}
result.allSourceAccounted =
  result.orphanMessages === 0 &&
  result.appliedThreads + result.refused.length === result.sourceThreads &&
  result.appliedMessages + result.refused.reduce((n, row) => n + row.messages, 0) ===
    result.sourceMessages;
result.sourceUnchanged = fingerprint(hashes()) === fingerprint(pins);
NodeFS.writeFileSync("/scratch/populated-receipt.private.json", JSON.stringify(result, null, 2), {
  mode: 0o600,
});
const { mapping: _mapping, refused, ...summary } = result;
process.stdout.write(
  JSON.stringify({
    ...summary,
    refusedThreads: refused.length,
    refusedByReason: Object.fromEntries(
      [...new Set(refused.map((r) => r.reason))].map((reason) => [
        reason,
        {
          threads: refused.filter((r) => r.reason === reason).length,
          messages: refused.filter((r) => r.reason === reason).reduce((n, r) => n + r.messages, 0),
        },
      ]),
    ),
  }) + "\n",
);
process.exitCode =
  result.failure ||
  !result.allSourceAccounted ||
  result.refused.length ||
  result.finalProjectionDrift ||
  !result.fixtureRowsUnchanged ||
  !result.sourceUnchanged ||
  !result.unrelatedUnchanged ||
  result.visibleItemMismatches ||
  result.lifecycleMismatches ||
  result.projectionMismatches ||
  result.metadataMismatches ||
  result.replayWrites
    ? 1
    : 0;
