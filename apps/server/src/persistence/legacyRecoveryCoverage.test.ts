// @effect-diagnostics-next-line nodeBuiltinImport:off -- Fixtures are real SQLite files with WAL sidecars.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Fixtures are real SQLite files with WAL sidecars.
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { assert, it } from "@effect/vitest";
import { OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { afterAll } from "vite-plus/test";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Legacy from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  hashFiles,
  measureRecoveryCoverage,
  runCoverageFromFiles,
} from "./legacyRecoveryCoverage.ts";
import { sourceInput } from "./legacyRecoveryFixture.testkit.ts";
import type { SnapshotInput } from "./legacySnapshotPlan.ts";
import * as Persistence from "./Sqlite.ts";

const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(Persistence.layerMemory),
);
const sink = EventSink.layer.pipe(Layer.provide(stores));
const layers = Layer.mergeAll(
  stores,
  sink,
  Legacy.layer.pipe(Layer.provide(Layer.mergeAll(stores, sink))),
);

/** The same importer-produced shell the mapper tests use. */
const fixtureInput = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const legacy = yield* Legacy.LegacyV1ThreadImporter;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('src-project','Official','/official','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
  yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,created_at,updated_at) VALUES('unrelated','src-project','Keep me','{"instanceId":"codex","model":"gpt-5.4"}','full-access','default','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
  yield* legacy.reconcileShells;
  const shell = (yield* projections.getThreadProjection(ThreadId.make("unrelated"))).thread;
  return sourceInput(shell, "Recovered", 0);
}).pipe(Effect.provide(layers));

const encode = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2DomainEvent));
type StagedRow = {
  stream_id: string;
  event_id: string;
  event_type: string;
  payload_json: string;
  occurred_at: string;
};
const stagedRows = (events: ReadonlyArray<OrchestrationV2DomainEvent>): StagedRow[] =>
  events.map((event) => {
    const json = encode(event) as {
      id: string;
      threadId: string;
      type: string;
      occurredAt: string;
      payload: unknown;
    };
    return {
      stream_id: json.threadId,
      event_id: json.id,
      event_type: json.type,
      occurred_at: json.occurredAt,
      payload_json: JSON.stringify(json.payload),
    };
  });

interface Fixture {
  lifecycle?: { fork?: string; archivedAt?: string | null };
  staged?: StagedRow[];
  extraMessages?: number;
}

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) {
    NodeFS.chmodSync(dir, 0o700);
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Writes WAL-mode legacy and staging stores and copies DB/WAL/SHM while the writers hold
 * them open, so the legacy history lives only in a nonempty WAL, like the preserved input.
 */
function writeStores(input: SnapshotInput, fixture: Fixture = {}) {
  const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "coverage-work-"));
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "coverage-input-"));
  dirs.push(work, dir);
  const open = (name: string, ddl: string) => {
    const db = new NodeSqlite.DatabaseSync(NodePath.join(work, name));
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; ${ddl}`);
    return db;
  };
  const legacy = open(
    "state.sqlite",
    "CREATE TABLE projection_threads(thread_id TEXT PRIMARY KEY,project_id TEXT,title TEXT,branch TEXT,worktree_path TEXT,created_at TEXT,updated_at TEXT,fork_source_thread_id TEXT,fork_source_message_id TEXT,archived_at TEXT,deleted_at TEXT); CREATE TABLE projection_thread_messages(thread_id TEXT,message_id TEXT PRIMARY KEY,role TEXT,text TEXT,created_at TEXT,updated_at TEXT,attachments_json TEXT,context_json TEXT,is_streaming INTEGER);",
  );
  // Schema lands in the main file; every history row stays in the WAL.
  legacy.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const t = input.thread;
  legacy
    .prepare("INSERT INTO projection_threads VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(
      t.thread_id,
      t.project_id,
      t.title,
      t.branch,
      t.worktree_path,
      t.created_at,
      t.updated_at,
      fixture.lifecycle?.fork ?? null,
      null,
      fixture.lifecycle?.archivedAt === undefined
        ? input.sourceLifecycle.archivedAt
        : fixture.lifecycle.archivedAt,
      input.sourceLifecycle.deletedAt,
    );
  const message = legacy.prepare(
    "INSERT INTO projection_thread_messages VALUES(?,?,?,?,?,?,?,?,?)",
  );
  for (const m of input.messages)
    message.run(
      m.thread_id,
      m.message_id,
      m.role,
      m.text,
      m.created_at,
      m.updated_at,
      m.attachments_json,
      m.context_json,
      m.is_streaming,
    );
  for (let i = 0; i < (fixture.extraMessages ?? 0); i++)
    message.run(
      "ghost-thread",
      `ghost-${i}`,
      "user",
      "x",
      t.created_at,
      t.created_at,
      "[]",
      null,
      0,
    );
  const staging = open(
    "statev2.sqlite",
    "CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT,aggregate_kind TEXT,stream_id TEXT,event_type TEXT,occurred_at TEXT,payload_json TEXT,application_event_version INTEGER);",
  );
  const event = staging.prepare(
    "INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,event_type,occurred_at,payload_json,application_event_version) VALUES(?,'thread',?,?,?,?,2)",
  );
  for (const row of fixture.staged ?? stagedRows(input.staged))
    event.run(row.event_id, row.stream_id, row.event_type, row.occurred_at, row.payload_json);
  staging.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  for (const name of ["state.sqlite", "statev2.sqlite"])
    for (const suffix of ["", "-wal", "-shm"])
      NodeFS.copyFileSync(NodePath.join(work, name + suffix), NodePath.join(dir, name + suffix));
  legacy.close();
  staging.close();
  // Read-only files and directory stand in for the read-only bind.
  for (const name of NodeFS.readdirSync(dir)) NodeFS.chmodSync(NodePath.join(dir, name), 0o444);
  NodeFS.chmodSync(dir, 0o555);
  const legacyPath = NodePath.join(dir, "state.sqlite");
  const stagingPath = NodePath.join(dir, "statev2.sqlite");
  const pins = hashFiles(
    ["", "-wal", "-shm"].flatMap((s) => [legacyPath + s, stagingPath + s]),
  ) as Record<string, string>;
  return { legacyPath, stagingPath, pins };
}

const run = (input: SnapshotInput, fixture?: Fixture) => {
  const files = writeStores(input, fixture);
  return runCoverageFromFiles({ ...files, sourceStoreId: "fixture-store" });
};
const summary = (result: ReturnType<typeof runCoverageFromFiles>) => {
  if (!("summary" in result)) throw new Error(`no coverage: ${result.status}`);
  return result.summary;
};
const variantRefusals = (result: ReturnType<typeof runCoverageFromFiles>) =>
  summary(result).variants.map((v) => v.mapperRefused);

it.effect("maps a supported WAL-only source in all four labelled variants with exact counts", () =>
  Effect.gen(function* () {
    const input = yield* fixtureInput;
    const files = writeStores(input);
    assert.isAbove(NodeFS.statSync(`${files.legacyPath}-wal`).size, 0);
    const result = runCoverageFromFiles({ ...files, sourceStoreId: "fixture-store" });
    assert.equal(result.status, "complete");
    const s = summary(result);
    assert.deepEqual(
      s.variants.map((v) => [v.variant, v.mappedThreads, v.complete]),
      [
        ["preserve/preserve", 1, true],
        ["preserve/detach", 1, true],
        ["visible/preserve", 1, true],
        ["visible/detach", 1, true],
      ],
    );
    assert.isTrue(s.accountedExactly);
    assert.deepEqual(
      [s.sourceDeletedThreads, s.sourceArchivedThreads, s.sourceEmptyThreads],
      [0, 1, 0],
    );
    const thread = "threads" in result ? result.threads[0]! : undefined;
    const expected = { messages: 2, reasoning: 1, attachments: 1, contextRecords: 1 };
    assert.deepEqual(thread?.source, expected);
    assert.deepEqual(thread?.lifecycle, { deleted: false, archived: true });
    for (const v of thread && "variants" in thread ? thread.variants! : [])
      assert.deepEqual("mapped" in v ? v.mapped : v, expected);
    // Receipts carry digests and counts, never transcript text.
    assert.notInclude(JSON.stringify(result), "Recovered user");
  }),
);

it.effect("an immutable open that ignores the WAL is the red control: nothing is accounted", () =>
  Effect.gen(function* () {
    const input = yield* fixtureInput;
    const files = writeStores(input);
    const legacy = new NodeSqlite.DatabaseSync(new URL(`file://${files.legacyPath}?immutable=1`), {
      readOnly: true,
    });
    const staging = new NodeSqlite.DatabaseSync(files.stagingPath, { readOnly: true });
    const ignored = measureRecoveryCoverage({
      legacy,
      staging,
      sourceStoreId: "fixture-store",
      sourceSnapshotSha256: "a".repeat(64),
    }).summary;
    legacy.close();
    staging.close();
    assert.equal(ignored.sourceThreads, 0);
    assert.isTrue(ignored.emptySource);
    assert.deepEqual(
      ignored.variants.map((v) => v.complete),
      [false, false, false, false],
    );
    assert.equal(ignored.unexpectedStagedThreads, 1);
    assert.isFalse(ignored.complete);
  }),
);

it.effect("an empty but exactly accounted capture is its own outcome, never complete", () =>
  Effect.gen(function* () {
    const files = writeStores(yield* fixtureInput, { staged: [] });
    // Immutable open hides the WAL-only rows, leaving both stores empty.
    const legacy = new NodeSqlite.DatabaseSync(new URL(`file://${files.legacyPath}?immutable=1`), {
      readOnly: true,
    });
    const staging = new NodeSqlite.DatabaseSync(files.stagingPath, { readOnly: true });
    const empty = measureRecoveryCoverage({
      legacy,
      staging,
      sourceStoreId: "fixture-store",
      sourceSnapshotSha256: "a".repeat(64),
    }).summary;
    legacy.close();
    staging.close();
    assert.equal(empty.sourceThreads, 0);
    assert.isTrue(empty.accountedExactly);
    assert.isTrue(empty.emptySource);
    assert.isFalse(empty.complete);
  }),
);

it.effect("wrong, missing, unpinned and extra pins stop before measuring", () =>
  Effect.gen(function* () {
    const input = yield* fixtureInput;
    const files = writeStores(input);
    const runWith = (pins: Record<string, string>) =>
      runCoverageFromFiles({ ...files, pins, sourceStoreId: "fixture-store" }).status;
    const without = (path: string) =>
      Object.fromEntries(Object.entries(files.pins).filter(([p]) => p !== path));
    for (const path of [files.legacyPath, `${files.legacyPath}-wal`, files.stagingPath]) {
      assert.equal(runWith({ ...files.pins, [path]: "0".repeat(64) }), "pin_mismatch_before");
      assert.equal(runWith(without(path)), "pin_set_mismatch");
    }
    assert.equal(runWith({ ...files.pins, "/nowhere": "0".repeat(64) }), "pin_set_mismatch");
    const missing = runCoverageFromFiles({
      ...files,
      legacyPath: `${files.legacyPath}.absent`,
      pins: Object.fromEntries(
        Object.entries(files.pins).map(([p, h]) => [
          p.startsWith(files.legacyPath)
            ? p.replace(files.legacyPath, `${files.legacyPath}.absent`)
            : p,
          h,
        ]),
      ),
      sourceStoreId: "fixture-store",
    });
    assert.equal(missing.status, "pin_mismatch_before");
    assert.deepEqual("mismatches" in missing ? missing.mismatches.map((m) => m.actual) : [], [
      null,
      null,
      null,
    ]);
  }),
);

it.effect("missing staged events are a counted builder refusal, never skipped", () =>
  Effect.gen(function* () {
    const result = run(yield* fixtureInput, { staged: [] });
    assert.equal(result.status, "incomplete");
    const s = summary(result);
    assert.deepEqual(s.builderRefused, { missing_staged_events: 1 });
    assert.isTrue(s.accountedExactly);
    assert.isFalse(s.complete);
    assert.deepEqual(
      s.variants.map((v) => v.mappedThreads),
      [0, 0, 0, 0],
    );
  }),
);

it.effect("invalid staged events and source forks are counted builder refusals", () =>
  Effect.gen(function* () {
    const input = yield* fixtureInput;
    const broken = stagedRows(input.staged).map((row, i) =>
      i === 1 ? { ...row, payload_json: "{}" } : row,
    );
    assert.deepEqual(summary(run(input, { staged: broken })).builderRefused, {
      invalid_staged_event: 1,
    });
    assert.deepEqual(summary(run(input, { lifecycle: { fork: "src-parent" } })).builderRefused, {
      source_fork_excluded: 1,
    });
    // A lifecycle disagreement between the stores is the builder's, not coverage's, to refuse.
    assert.deepEqual(summary(run(input, { lifecycle: { archivedAt: null } })).builderRefused, {
      source_lifecycle_mismatch: 1,
    });
  }),
);

it.effect("a mapper refusal is counted per labelled variant and keeps the gate red", () =>
  Effect.gen(function* () {
    const input = yield* fixtureInput;
    const staged = input.staged.map((e) =>
      e.type === "thread.created"
        ? ({
            ...e,
            payload: { ...e.payload, activeProviderThreadId: "provider-thread" },
          } as OrchestrationV2DomainEvent)
        : e,
    );
    const result = run(input, { staged: stagedRows(staged) });
    assert.equal(result.status, "incomplete");
    assert.deepEqual(summary(result).builderRefused, {});
    const refusals = variantRefusals(result);
    assert.lengthOf(refusals, 4);
    for (const r of refusals)
      assert.equal(
        Object.values(r).reduce((a, b) => a + b, 0),
        1,
      );
    assert.isTrue(summary(result).accountedExactly);
  }),
);

it.effect("unexpected staged threads and orphan messages fail exact accounting", () =>
  Effect.gen(function* () {
    const input = yield* fixtureInput;
    const extra = stagedRows(input.staged).map((row) => ({
      ...row,
      stream_id: "stray-thread",
      event_id: `stray-${row.event_id}`,
    }));
    const stray = summary(run(input, { staged: [...stagedRows(input.staged), ...extra] }));
    assert.equal(stray.unexpectedStagedThreads, 1);
    assert.isFalse(stray.accountedExactly);
    assert.isFalse(stray.complete);
    const orphan = summary(run(input, { extraMessages: 2 }));
    assert.equal(orphan.orphanMessages, 2);
    assert.isFalse(orphan.accountedExactly);
    assert.isFalse(orphan.complete);
  }),
);
