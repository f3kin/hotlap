// @effect-diagnostics nodeBuiltinImport:off
// Explicit sandbox-only diagnostic. Never imports the server/provider runtime.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../src/config.ts";
import * as Persistence from "../src/persistence/Sqlite.ts";
import * as EventStore from "../src/orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../src/orchestration-v2/EventSink.ts";
import * as Legacy from "../src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import { compareHistory, type HistoryMessage } from "../src/persistence/legacyRehearsalCheck.ts";

import { captureLegacyBaseline } from "../src/persistence/legacyRehearsalBaseline.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const iso = (value: string) => DateTime.formatIso(DateTime.makeUnsafe(value));
const digest = (path: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");
const sourceFiles = [
  "/input/state.sqlite",
  "/input/state.sqlite-wal",
  "/input/state.sqlite-shm",
].filter(NodeFS.existsSync);
const before = sourceFiles.map(digest);
const result = {
  kind: "native_legacy_rehearsal",
  ok: false,
  threads: 0,
  messages: 0,
  missing: 0,
  extra: 0,
  extraThreads: 0,
  changed: 0,
  orderChanged: 0,
  threadMetadataChanged: 0,
  unequalComparisons: 0,
  metadataNormalisations: 0,
  hydrationErrors: 0,
  pending: 0,
  invalidSourceJson: 0,
  repeatChanged: 0,
  sourceUnchanged: false,
  excludedRoles: 0,
  streamingNormalised: 0,
  failure: null as string | null,
};
try {
  if (NodeFS.existsSync("/scratch/userdata")) throw new Error("destination_exists");
  NodeFS.mkdirSync("/scratch/userdata", { recursive: true, mode: 0o700 });
  const input = new NodeSqlite.DatabaseSync("/input/state.sqlite", { readOnly: true });
  const baseline = captureLegacyBaseline(input);
  try {
    await NodeSqlite.backup(input, "/scratch/userdata/state.sqlite");
  } finally {
    input.close();
  }
  const configLayer = ServerConfig.layerTest("/scratch", "/scratch").pipe(
    Layer.provideMerge(NodeServices.layer),
  );
  const run = Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const database = Persistence.layerConfig.pipe(Layer.provide(ServerConfig.layer(config)));
    const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
      Layer.provideMerge(database),
    );
    const sink = EventSink.layer.pipe(Layer.provide(stores));
    const importer = Legacy.layer.pipe(Layer.provideMerge(Layer.mergeAll(stores, sink)));
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const legacy = yield* Legacy.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threads = baseline.threads;
      result.excludedRoles = baseline.messages.filter(
        (m) => m.role !== "user" && m.role !== "assistant",
      ).length;
      result.streamingNormalised = baseline.messages.filter((m) => m.is_streaming === 1).length;
      yield* legacy.reconcileShells;
      const expectedThreadIds = new Set(threads.map((row) => row.thread_id));
      const targetThreads = yield* sql<{
        thread_id: string;
      }>`SELECT thread_id FROM orchestration_v2_projection_threads`;
      result.extraThreads = targetThreads.filter(
        (row) => !expectedThreadIds.has(row.thread_id),
      ).length;
      for (const row of threads) {
        result.threads++;
        const raws = baseline.messages.filter(
          (m) => m.thread_id === row.thread_id && (m.role === "user" || m.role === "assistant"),
        );
        const expected = yield* Effect.try((): HistoryMessage[] =>
          raws.map((m) => ({
            id: m.message_id,
            role: m.role,
            text: m.text,
            createdAt: iso(m.created_at),
            updatedAt: iso(m.updated_at),
            attachments: decodeJson(m.attachments_json ?? "[]"),
            context: decodeJson(m.context_json ?? "null"),
          })),
        ).pipe(Effect.match({ onFailure: () => null, onSuccess: (messages) => messages }));
        if (expected === null) {
          result.invalidSourceJson++;
          continue;
        }
        result.messages += expected.length;
        const hydrated = yield* legacy
          .ensureTranscript(ThreadId.make(row.thread_id))
          .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
        if (!hydrated) {
          result.hydrationErrors++;
          continue;
        }
        const projection = yield* projections.getThreadProjection(ThreadId.make(row.thread_id));
        const actual = projection.messages.map((m) => ({
          id: m.id,
          role: m.role,
          text: m.text,
          createdAt: DateTime.formatIso(m.createdAt),
          updatedAt: DateTime.formatIso(m.updatedAt),
          attachments: m.attachments,
          context: m.context ?? null,
        }));
        const comparison = compareHistory(expected, actual);
        result.unequalComparisons += Number(!comparison.equal);
        result.missing += comparison.missing;
        result.extra += comparison.extra;
        result.changed += comparison.changed;
        result.orderChanged += Number(comparison.orderChanged);
        result.metadataNormalisations += Number(
          row.title.trim() === "" ||
            (row.branch !== null && row.branch !== (row.branch.trim() || null)) ||
            (row.worktree_path !== null &&
              row.worktree_path !== (row.worktree_path.trim() || null)),
        );
        const t = projection.thread;
        if (
          t.id !== row.thread_id ||
          t.projectId !== row.project_id ||
          t.title !== (row.title.trim() ? row.title : "Untitled thread") ||
          t.branch !== (row.branch?.trim() || null) ||
          t.worktreePath !== (row.worktree_path?.trim() || null) ||
          DateTime.formatIso(t.createdAt) !== iso(row.created_at) ||
          DateTime.formatIso(t.updatedAt) !== iso(row.updated_at)
        )
          result.threadMetadataChanged++;
        const prior = encodeJson(projection);
        const eventCount = Number(
          (yield* sql`SELECT count(*) AS n FROM orchestration_events`)[0]?.n,
        );
        yield* legacy.ensureTranscript(ThreadId.make(row.thread_id));
        if (
          encodeJson(yield* projections.getThreadProjection(ThreadId.make(row.thread_id))) !==
            prior ||
          Number((yield* sql`SELECT count(*) AS n FROM orchestration_events`)[0]?.n) !== eventCount
        )
          result.repeatChanged++;
      }
      result.pending = Number(
        (yield* sql`SELECT count(*) AS n FROM orchestration_v2_legacy_imports WHERE transcript_imported_at IS NULL OR last_error IS NOT NULL`)[0]
          ?.n ?? 0,
      );
    }).pipe(Effect.provide(importer));
  }).pipe(Effect.provide(configLayer), Effect.scoped);
  await Effect.runPromise(run);
} catch {
  result.failure = "native_rehearsal_failed";
}
result.sourceUnchanged = JSON.stringify(sourceFiles.map(digest)) === JSON.stringify(before);
result.ok =
  result.sourceUnchanged &&
  result.failure === null &&
  [
    result.missing,
    result.extra,
    result.extraThreads,
    result.changed,
    result.orderChanged,
    result.threadMetadataChanged,
    result.hydrationErrors,
    result.pending,
    result.invalidSourceJson,
    result.repeatChanged,
    result.excludedRoles,
    result.unequalComparisons,
  ].every((n) => n === 0);
NodeFS.writeFileSync(
  "/scratch/receipt.json",
  JSON.stringify(
    {
      ...result,
      scope:
        "user/assistant message identity/order/text/time/context/attachments and selected thread metadata; per-thread hydration idempotence",
      unsupported: [
        "fork/session resumption semantics",
        "attachment file resolution/rendering",
        "populated-target merge",
        "whole backup completeness",
        "title blank fallback and branch/worktree whitespace/null normalisation counted separately",
      ],
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
process.stdout.write(JSON.stringify(result) + "\n");
process.exitCode = result.ok ? 0 : 1;
