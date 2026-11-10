// @effect-diagnostics-next-line nodeBuiltinImport:off -- The independent oracle recomputes identities without the mapper.
import * as NodeCrypto from "node:crypto";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  OrchestrationV2DomainEvent,
  ProjectId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Legacy from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { buildLegacySnapshotPlan, type SnapshotInput } from "./legacySnapshotPlan.ts";
import { mapRecoveryPlan, type RecoveryMappingOptions } from "./legacyRecoveryMapping.ts";
import { applySandboxPlan, makeSandboxPlan, type SandboxPlan } from "./SandboxHistoryImport.ts";
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

const STORE = "hotlap-original";
const ATTACHMENT = "src-thread-11111111-1111-1111-1111-111111111111";
const image = {
  type: "image" as const,
  id: ATTACHMENT,
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 10,
};
const context = {
  version: 1 as const,
  records: [
    {
      version: 1,
      contextId: "ctx_1",
      label: "shot.png",
      kind: "image",
      attachmentId: ATTACHMENT,
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 10,
    },
  ],
};
const at = (day: number) => `2026-01-0${day}T00:00:00.000Z`;

// Independent oracle: recomputed here, never imported from the mapper.
const expectedId = (kind: string, sourceId: string) =>
  `rcv-${NodeCrypto.createHash("sha256")
    .update(JSON.stringify([kind, STORE, sourceId]))
    .digest("hex")
    .slice(0, 24)}`;

/** A source-faithful builder input: user (image + context), reasoning, assistant. */
const sourceInput = (shell: unknown, text: string, baseline: number): SnapshotInput => {
  const id = ThreadId.make("src-thread");
  const thread = {
    ...(shell as object),
    id,
    projectId: ProjectId.make("src-project"),
    title: "Recovered",
    branch: "feature",
    worktreePath: "/source/checkout",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    createdAt: DateTime.makeUnsafe(at(1)),
    updatedAt: DateTime.makeUnsafe(at(5)),
    archivedAt: DateTime.makeUnsafe(at(4)),
    deletedAt: null,
  } as Extract<OrchestrationV2DomainEvent, { type: "thread.created" }>["payload"];
  const message = (mid: string, role: "user" | "assistant", day: number) => ({
    id: MessageId.make(mid),
    threadId: id,
    createdBy: "user" as const,
    creationSource: "server" as const,
    runId: null,
    nodeId: null,
    role,
    text: `${text} ${role}`,
    attachments: role === "user" ? [image] : [],
    ...(role === "user" ? { context } : {}),
    streaming: false,
    createdAt: DateTime.makeUnsafe(at(day)),
    updatedAt: DateTime.makeUnsafe(at(day)),
  });
  const base = (iid: string, ordinal: number, day: number) => ({
    id: TurnItemId.make(iid),
    threadId: id,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: DateTime.makeUnsafe(at(day)),
    completedAt: DateTime.makeUnsafe(at(day)),
    updatedAt: DateTime.makeUnsafe(at(day)),
  });
  const user = message("src-msg-user", "user", 2);
  const assistant = message("src-msg-asst", "assistant", 3);
  const event = (eid: string, payload: unknown, type: string, day: number) =>
    ({
      id: EventId.make(eid),
      threadId: id,
      type,
      occurredAt: DateTime.makeUnsafe(at(day)),
      payload,
    }) as OrchestrationV2DomainEvent;
  return {
    thread: {
      thread_id: "src-thread",
      project_id: "src-project",
      title: "Recovered",
      branch: "feature",
      worktree_path: "/source/checkout",
      created_at: at(1),
      updated_at: at(5),
    },
    sourceLifecycle: {
      forkSourceThreadId: null,
      forkSourceMessageId: null,
      archivedAt: at(4),
      deletedAt: null,
    },
    messages: [
      {
        thread_id: "src-thread",
        message_id: "src-msg-user",
        role: "user",
        text: user.text,
        created_at: at(2),
        updated_at: at(2),
        attachments_json: JSON.stringify([image]),
        context_json: JSON.stringify(context),
        is_streaming: 0,
      },
      {
        thread_id: "src-thread",
        message_id: "src-msg-reason",
        role: "reasoning",
        text: `${text} thinking`,
        created_at: at(2),
        updated_at: at(3),
        attachments_json: "[]",
        context_json: null,
        is_streaming: 0,
      },
      {
        thread_id: "src-thread",
        message_id: "src-msg-asst",
        role: "assistant",
        text: assistant.text,
        created_at: at(3),
        updated_at: at(3),
        attachments_json: "[]",
        context_json: null,
        is_streaming: 0,
      },
    ],
    staged: [
      event("s:create", thread, "thread.created", 1),
      event("s:user", user, "message.updated", 2),
      event(
        "s:user-item",
        {
          ...base("src-item-user", 1, 2),
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId: user.id,
          inputIntent: "turn_start",
          text: user.text,
          attachments: [image],
          context,
        },
        "turn-item.updated",
        2,
      ),
      event("s:asst", assistant, "message.updated", 3),
      event(
        "s:asst-item",
        {
          ...base("src-item-asst", 2, 3),
          type: "assistant_message",
          messageId: assistant.id,
          text: assistant.text,
          streaming: false,
        },
        "turn-item.updated",
        3,
      ),
      event("s:meta", thread, "thread.metadata-updated", 5),
    ],
    sourceSnapshotSha256: "a".repeat(64),
    targetBaselineSequence: baseline,
  };
};
const built = (input: SnapshotInput) => {
  const result = buildLegacySnapshotPlan(input);
  if (!("plan" in result)) throw new Error(`builder refused: ${result.refused}`);
  return result.plan;
};
const options: RecoveryMappingOptions = {
  sourceStoreId: STORE,
  projectMap: { "src-project": ProjectId.make("recovery-project") },
  lifecycle: "visible",
  workspace: "detach",
};
const mapped = (plan: SandboxPlan, overrides: Partial<RecoveryMappingOptions> = {}) => {
  const result = mapRecoveryPlan(plan, { ...options, ...overrides });
  if (!("plan" in result)) throw new Error(`mapper refused: ${result.refused}`);
  return result;
};

type Snapshot = Record<string, string[]>;
const snapshot = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{
    name: string;
  }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`;
  const result: Snapshot = {};
  for (const { name } of tables) {
    // quote() keeps FTS varint blobs and large integers exact as text.
    const columns = yield* sql.unsafe<{ name: string }>(
      `SELECT name FROM pragma_table_info('${name}')`,
    );
    const select = columns.map((c) => `quote("${c.name}") AS "${c.name}"`).join(",");
    result[name] = (yield* sql.unsafe<Record<string, string>>(`SELECT ${select} FROM "${name}"`))
      .map((row) => JSON.stringify(row))
      .sort();
  }
  return result;
});
/** Rows removed from and added to each table, as multisets. */
const diff = (before: Snapshot, after: Snapshot) => {
  const result: Record<string, { removed: string[]; added: string[] }> = {};
  for (const table of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const remaining = [...(after[table] ?? [])];
    const removed: string[] = [];
    for (const row of before[table] ?? []) {
      const index = remaining.indexOf(row);
      if (index === -1) removed.push(row);
      else remaining.splice(index, 1);
    }
    if (removed.length || remaining.length) result[table] = { removed, added: remaining };
  }
  return result;
};

const world = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const legacy = yield* Legacy.LegacyV1ThreadImporter;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventStore = yield* EventStore.EventStoreV2;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('src-project','Official','/official','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
  yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,created_at,updated_at) VALUES('unrelated','src-project','Keep me','{"instanceId":"codex","model":"gpt-5.4"}','full-access','default','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
  yield* legacy.reconcileShells;
  const shell = (yield* projections.getThreadProjection(ThreadId.make("unrelated"))).thread;
  // Official history already holds the same source IDs with different content.
  const official = built(
    sourceInput(shell, "Official", yield* eventStore.latestApplicationSequence),
  );
  assert.equal((yield* applySandboxPlan(official)).status, "applied");
  // Fixture step only: the real operator must create this project inside its own manifest.
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('recovery-project','Recovery','/recovery-neutral','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
  const source = built(
    sourceInput(shell, "Recovered", yield* eventStore.latestApplicationSequence),
  );
  return { sql, projections, eventStore, shell, source };
});

const FTS_TABLES = new Set(
  ["", "_data", "_idx", "_docsize", "_config"].map(
    (suffix) => `orchestration_v2_message_search${suffix}`,
  ),
);
/**
 * Every pre-existing row must survive unchanged and every new row must belong to the target
 * thread. The only documented exceptions are the event AUTOINCREMENT counter, the thread
 * projection cursor and the FTS5 index storage, whose preservation is checked logically.
 */
const footprintViolations = (
  d: ReturnType<typeof diff>,
  expected: { targetThreadId: string; eventsWritten: number; latestSequence: number },
) => {
  const violations: string[] = [];
  const one = (rows: string[]) =>
    rows.length === 1
      ? Object.fromEntries(
          Object.entries(JSON.parse(rows[0]!) as Record<string, string>).map(([k, v]) => [
            k,
            /^'.*'$/s.test(v) ? v.slice(1, -1) : Number(v),
          ]),
        )
      : undefined;
  for (const [table, { removed, added }] of Object.entries(d)) {
    if (FTS_TABLES.has(table)) continue;
    if (table === "sqlite_sequence") {
      const [was, now] = [one(removed), one(added)];
      if (
        !was ||
        !now ||
        was.name !== "orchestration_events" ||
        now.name !== was.name ||
        now.seq !== was.seq + expected.eventsWritten
      )
        violations.push("sqlite_sequence: unexpected counter change");
    } else if (table === "orchestration_v2_projection_metadata") {
      const [was, now] = [one(removed), one(added)];
      if (
        !was ||
        !now ||
        was.projection_name !== "thread-projections" ||
        now.projection_name !== was.projection_name ||
        now.schema_version !== was.schema_version ||
        now.last_sequence !== expected.latestSequence
      )
        violations.push("projection_metadata: unexpected cursor change");
    } else {
      if (removed.length) violations.push(`${table}: ${removed.length} existing row(s) changed`);
      for (const row of added)
        if (!row.includes(`'${expected.targetThreadId}'`))
          violations.push(`${table}: new row outside target thread`);
    }
  }
  return violations;
};
const SOURCE_IDS = new Set([
  "src-thread",
  "src-project",
  "src-msg-user",
  "src-msg-asst",
  "src-item-user",
  "src-item-asst",
  "migration:v1:turn-item:src-msg-reason",
  ATTACHMENT,
]);
/** Walks every string leaf (including nested payload JSON) for a surviving source identity. */
const sourceIdLeaks = (rows: string[]) => {
  const leaks: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      if (/^'.*'$/s.test(value)) return walk(value.slice(1, -1).replaceAll("''", "'"));
      if (SOURCE_IDS.has(value)) leaks.push(value);
      else if (value.startsWith("{") || value.startsWith("["))
        try {
          walk(JSON.parse(value));
        } catch {}
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
  };
  rows.forEach((row) => walk(JSON.parse(row)));
  return leaks;
};
const searchRowIds = (term: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return (yield* sql<{
      rowid: number;
    }>`SELECT rowid FROM orchestration_v2_message_search WHERE orchestration_v2_message_search MATCH ${term} ORDER BY rowid`).map(
      (row) => row.rowid,
    );
  });
/** Independent oracle for order: positions and payload ordinals must both follow source order. */
const recoveredOrder = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ turn_item_id: string; ordinal: number; payload_json: string }>`
      SELECT p.turn_item_id, p.ordinal, i.payload_json FROM orchestration_v2_turn_item_positions p
      JOIN orchestration_v2_projection_turn_items i ON i.turn_item_id = p.turn_item_id
      WHERE p.thread_id = ${threadId} ORDER BY p.ordinal`;
    return rows.map((row) => {
      const payload = JSON.parse(row.payload_json);
      return {
        id: row.turn_item_id,
        ordinal: row.ordinal,
        payloadOrdinal: payload.ordinal,
        type: payload.type,
        text: payload.text,
      };
    });
  });
const encodeEvents = Schema.encodeSync(
  Schema.toCodecJson(Schema.Array(OrchestrationV2DomainEvent)),
);
const decodeEvents = Schema.decodeUnknownSync(
  Schema.toCodecJson(Schema.Array(OrchestrationV2DomainEvent)),
);
/** The approved plan as a batch journal would persist it, then read back for replay. */
const persisted = (plan: SandboxPlan): SandboxPlan => {
  const stored = JSON.parse(JSON.stringify({ ...plan, events: encodeEvents(plan.events) }));
  return { ...stored, events: decodeEvents(stored.events) };
};
const refusedWithoutWrites = (plan: SandboxPlan) =>
  Effect.gen(function* () {
    const before = yield* snapshot;
    assert.isTrue(Exit.isFailure(yield* applySandboxPlan(plan).pipe(Effect.exit)));
    assert.deepEqual(diff(before, yield* snapshot), {});
  });

it.effect(
  "adds same-ID source history under new identities and leaves every existing row unchanged",
  () =>
    Effect.gen(function* () {
      const w = yield* world;
      // Red control: the unmapped source really collides with official history.
      yield* refusedWithoutWrites(w.source);
      const before = yield* snapshot;
      const officialHits = yield* searchRowIds("Official");
      const { plan, provenance } = mapped(w.source);
      assert.deepEqual(mapped(w.source).provenance, provenance);
      assert.equal((yield* applySandboxPlan(plan)).status, "applied");
      const after = yield* snapshot;
      const target = expectedId("thread", "src-thread");
      const d = diff(before, after);
      assert.deepEqual(
        footprintViolations(d, {
          targetThreadId: target,
          eventsWritten: plan.events.length,
          latestSequence: yield* w.eventStore.latestApplicationSequence,
        }),
        [],
      );
      assert.deepEqual(
        sourceIdLeaks(
          Object.entries(d)
            .filter(([t]) => !FTS_TABLES.has(t))
            .flatMap(([, c]) => c.added),
        ),
        [],
      );
      // Search keeps every official hit and indexes the recovered copy.
      assert.deepEqual(yield* searchRowIds("Official"), officialHits);
      assert.equal((yield* searchRowIds("Recovered")).length, 2);
      yield* w.sql`INSERT INTO orchestration_v2_message_search(orchestration_v2_message_search) VALUES('integrity-check')`;

      assert.deepEqual(yield* recoveredOrder(target), [
        {
          id: expectedId("turn-item", "src-item-user"),
          ordinal: 1,
          payloadOrdinal: 1,
          type: "user_message",
          text: "Recovered user",
        },
        {
          id: expectedId("turn-item", "migration:v1:turn-item:src-msg-reason"),
          ordinal: 2,
          payloadOrdinal: 2,
          type: "reasoning",
          text: "Recovered thinking",
        },
        {
          id: expectedId("turn-item", "src-item-asst"),
          ordinal: 3,
          payloadOrdinal: 3,
          type: "assistant_message",
          text: "Recovered assistant",
        },
      ]);
      const recovered = yield* w.projections.getThreadProjection(ThreadId.make(target));
      assert.equal(recovered.thread.projectId, "recovery-project");
      assert.equal(recovered.thread.title, "Recovered");
      assert.equal(recovered.thread.archivedAt, null);
      assert.equal(recovered.thread.worktreePath, null);
      assert.equal(recovered.thread.branch, "feature");
      assert.equal(DateTime.formatIso(recovered.thread.updatedAt), at(5));
      const user = recovered.messages.find((m) => m.role === "user")!;
      assert.equal(user.id, expectedId("message", "src-msg-user"));
      assert.equal(DateTime.formatIso(user.createdAt), at(2));
      const attachmentId = user.attachments[0]!.id;
      assert.isTrue(attachmentId.startsWith(`${target}-`));
      assert.equal(
        (user.context!.records[0] as { attachmentId?: string }).attachmentId,
        attachmentId,
      );
      assert.deepEqual(provenance.attachments, [
        {
          sourceAttachmentId: ATTACHMENT,
          targetAttachmentId: attachmentId,
          sourceRelativePath: `${ATTACHMENT}.png`,
          targetRelativePath: `${attachmentId}.png`,
        },
      ]);
      assert.deepEqual(
        provenance.transformations.map((t) => [
          t.field,
          t.sourceValue === null ? null : "set",
          t.targetValue,
        ]),
        [
          ["archivedAt", "set", null],
          ["worktreePath", "set", null],
          ["archivedAt", "set", null],
          ["worktreePath", "set", null],
        ],
      );

      // Replay reads back the persisted approved plan and writes nothing.
      assert.equal((yield* applySandboxPlan(persisted(plan))).status, "already_exact");
      assert.deepEqual(diff(after, yield* snapshot), {});
      // A plan regenerated at the current baseline is a different batch, not a replay.
      const regenerated = built(
        sourceInput(w.shell, "Recovered", yield* w.eventStore.latestApplicationSequence),
      );
      yield* refusedWithoutWrites(mapped(regenerated).plan);
      // A changed source under the same store namespace refuses rather than duplicating.
      const changed = built(sourceInput(w.shell, "Edited", plan.targetBaselineSequence));
      yield* refusedWithoutWrites(mapped(changed).plan);
    }).pipe(Effect.provide(layers)),
);

it.effect("the row and leak oracles fail on a mutated existing row or an unmapped identity", () =>
  Effect.gen(function* () {
    const w = yield* world;
    const before = yield* snapshot;
    yield* w.sql`UPDATE orchestration_v2_projection_messages SET role = role WHERE 0`;
    const { plan } = mapped(w.source);
    yield* applySandboxPlan(plan);
    yield* w.sql`UPDATE orchestration_v2_projection_threads SET title = 'Tampered' WHERE thread_id = 'unrelated'`;
    const d = diff(before, yield* snapshot);
    const expected = {
      targetThreadId: expectedId("thread", "src-thread"),
      eventsWritten: plan.events.length,
      latestSequence: yield* w.eventStore.latestApplicationSequence,
    };
    assert.include(
      footprintViolations(d, expected),
      "orchestration_v2_projection_threads: 1 existing row(s) changed",
    );
    assert.include(
      footprintViolations(d, { ...expected, latestSequence: 0 }),
      "projection_metadata: unexpected cursor change",
    );
    assert.isAbove(sourceIdLeaks(before.orchestration_v2_projection_messages ?? []).length, 0);
  }).pipe(Effect.provide(layers)),
);

it.effect("rolls back a failed mapped write completely and then applies cleanly", () =>
  Effect.gen(function* () {
    const w = yield* world;
    const real = yield* EventSink.EventSinkV2;
    const { plan } = mapped(w.source);
    for (const write of [
      (input: Parameters<typeof real.write>[0]) =>
        real.write({ ...input, events: [...input.events, input.events[0]!] }),
      (input: Parameters<typeof real.write>[0]) =>
        real.write(input).pipe(Effect.andThen(Effect.interrupt)),
    ]) {
      const before = yield* snapshot;
      const failed = yield* applySandboxPlan(plan).pipe(
        Effect.provideService(EventSink.EventSinkV2, { ...real, write }),
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(failed));
      assert.deepEqual(diff(before, yield* snapshot), {});
    }
    assert.equal((yield* applySandboxPlan(plan)).status, "applied");
  }).pipe(Effect.provide(layers)),
);

it.effect("refuses when a mapped identity is already used by unrelated official history", () =>
  Effect.gen(function* () {
    const w = yield* world;
    const real = yield* EventSink.EventSinkV2;
    const user = mapped(w.source).plan.events.find((e) => e.type === "message.updated")!;
    if (user.type !== "message.updated") return;
    yield* real.write({
      events: [
        {
          ...user,
          id: EventId.make("seed"),
          threadId: ThreadId.make("unrelated"),
          payload: { ...user.payload, threadId: ThreadId.make("unrelated") },
        },
      ],
    });
    const current = built(
      sourceInput(w.shell, "Recovered", yield* w.eventStore.latestApplicationSequence),
    );
    yield* refusedWithoutWrites(mapped(current).plan);
  }).pipe(Effect.provide(layers)),
);

it.effect.each([
  [
    "missing message",
    "DELETE FROM orchestration_v2_projection_messages WHERE thread_id = $t AND role = 'assistant'",
  ],
  [
    "corrupted text",
    "UPDATE orchestration_v2_projection_messages SET payload_json = json_set(payload_json, '$.text', 'x') WHERE thread_id = $t AND role = 'user'",
  ],
  [
    "reordered items",
    "UPDATE orchestration_v2_projection_turn_items SET payload_json = json_set(payload_json, '$.ordinal', 4 - json_extract(payload_json, '$.ordinal')) WHERE thread_id = $t AND type <> 'reasoning'",
  ],
] as const)("replay detects %s recovered output", ([, corrupt]) =>
  Effect.gen(function* () {
    const w = yield* world;
    const { plan } = mapped(w.source);
    yield* applySandboxPlan(plan);
    yield* w.sql.unsafe(corrupt.replace("$t", "?"), [plan.targetThreadId]);
    yield* refusedWithoutWrites(persisted(plan));
  }).pipe(Effect.provide(layers)),
);

it.effect("the order oracle fails on swapped stored positions the adapter readback ignores", () =>
  Effect.gen(function* () {
    const w = yield* world;
    const { plan } = mapped(w.source);
    yield* applySandboxPlan(plan);
    yield* w.sql`UPDATE orchestration_v2_turn_item_positions SET ordinal = -ordinal WHERE thread_id = ${plan.targetThreadId}`;
    yield* w.sql`UPDATE orchestration_v2_turn_item_positions SET ordinal = 4 + ordinal WHERE thread_id = ${plan.targetThreadId}`;
    const order = yield* recoveredOrder(plan.targetThreadId);
    assert.notDeepEqual(
      order.map((o) => o.payloadOrdinal),
      order.map((o) => o.ordinal),
    );
  }).pipe(Effect.provide(layers)),
);

const rebuild = (plan: SandboxPlan, change: (event: OrchestrationV2DomainEvent) => unknown) =>
  makeSourcePlan(
    plan,
    plan.events.map(
      (event, index) =>
        ({
          ...(change(event) as object),
          id: plan.sourceEventIds[index]!,
        }) as OrchestrationV2DomainEvent,
    ),
  );
const makeSourcePlan = (plan: SandboxPlan, events: OrchestrationV2DomainEvent[]) =>
  makeSandboxPlan({ ...plan, events });
const onType =
  (type: string, patch: (payload: Record<string, unknown>) => Record<string, unknown>) =>
  (event: OrchestrationV2DomainEvent) =>
    event.type === type ? { ...event, payload: patch(event.payload as never) } : event;
const userItem =
  (patch: (payload: Record<string, unknown>) => Record<string, unknown>) =>
  (event: OrchestrationV2DomainEvent) =>
    event.type === "turn-item.updated" && event.payload.type === "user_message"
      ? { ...event, payload: patch(event.payload as never) }
      : event;

it.effect("refuses unmapped, runtime-linked or ambiguous references instead of omitting them", () =>
  Effect.gen(function* () {
    const { source } = yield* world;
    const refused = (plan: SandboxPlan, overrides: Partial<RecoveryMappingOptions> = {}) =>
      mapRecoveryPlan(plan, { ...options, ...overrides });
    const cases: Array<[unknown, string]> = [
      [refused(source, { projectMap: {} }), "unmapped_project"],
      [
        refused(source, { projectMap: { "src-project": ProjectId.make("src-project") } }),
        "unmapped_reference",
      ],
      [refused(source, { sourceStoreId: "Bad Store" }), "invalid_source_store_id"],
      [refused({ ...source, sourceSnapshotSha256: "b".repeat(64) }), "source_plan_digest_mismatch"],
      [refused(mapped(source).plan), "source_plan_already_mapped"],
      [
        refused(
          rebuild(
            source,
            onType("message.updated", (m) => ({ ...m, senderThreadId: "src-other" })),
          ),
        ),
        "unsupported_message_field:senderThreadId",
      ],
      [
        refused(
          rebuild(
            source,
            onType("message.updated", (m) => ({ ...m, runId: "run" })),
          ),
        ),
        "unsupported_runtime_link",
      ],
      [
        refused(
          rebuild(
            source,
            onType("message.updated", (m) => ({ ...m, futureField: "x" })),
          ),
        ),
        "unknown_message_field:futureField",
      ],
      [
        refused(
          rebuild(
            source,
            onType("thread.created", (t) => ({ ...t, forkedFrom: { type: "node", nodeId: "n" } })),
          ),
        ),
        "unsupported_thread_field:forkedFrom",
      ],
      [
        refused(
          rebuild(
            source,
            onType("thread.created", (t) => ({ ...t, futureField: 1 })),
          ),
        ),
        "unknown_thread_field:futureField",
      ],
      [
        refused(
          rebuild(
            source,
            onType("thread.created", (t) => ({
              ...t,
              lineage: { parentThreadId: "p", relationshipToParent: "fork", rootThreadId: "p" },
            })),
          ),
        ),
        "unsupported_thread_lineage",
      ],
      [
        refused(
          rebuild(
            source,
            userItem((i) => ({ ...i, messageId: "src-elsewhere" })),
          ),
        ),
        "unmapped_reference",
      ],
      [
        refused(
          rebuild(
            source,
            userItem((i) => ({ ...i, parentItemId: "src-other-item" })),
          ),
        ),
        "unsupported_runtime_link",
      ],
      [
        refused(
          rebuild(
            source,
            userItem((i) => ({
              ...i,
              deferredWork: { cursor: "c", itemCount: 1, lastOrdinal: 1 },
            })),
          ),
        ),
        "unsupported_turn_item_field:deferredWork",
      ],
      [
        refused(
          rebuild(
            source,
            onType("message.updated", (m) => ({ ...m, attachments: [{ ...image, type: "html" }] })),
          ),
        ),
        "unsupported_attachment_type",
      ],
      [
        refused(
          rebuild(
            source,
            onType("message.updated", (m) =>
              m.context
                ? {
                    ...m,
                    context: { version: 1, records: [{ kind: "thread", threadId: "src-other" }] },
                  }
                : m,
            ),
          ),
        ),
        "unsupported_context_record:thread",
      ],
      [
        refused(
          rebuild(
            source,
            onType("message.updated", (m) =>
              m.context ? { ...m, context: { ...context, guest: { shareId: "s" } } } : m,
            ),
          ),
        ),
        "unsupported_context_field:guest",
      ],
      [
        refused(
          rebuild(
            source,
            onType("message.updated", (m) => (m.context ? { ...m, attachments: [] } : m)),
          ),
        ),
        "unmapped_context_attachment",
      ],
    ];
    const withAttachment = (patch: Record<string, unknown>) =>
      rebuild(
        source,
        onType("message.updated", (m) =>
          m.context ? { ...m, attachments: [{ ...image, ...patch }] } : m,
        ),
      );
    const withRecord = (patch: Record<string, unknown>) =>
      rebuild(
        source,
        onType("message.updated", (m) =>
          m.context
            ? { ...m, context: { ...context, records: [{ ...context.records[0], ...patch }] } }
            : m,
        ),
      );
    cases.push(
      [
        refused(withAttachment({ senderThreadId: "src-other" })),
        "unknown_attachment_field:senderThreadId",
      ],
      [
        refused(withAttachment({ source: { _tag: "pasted-text" } })),
        "unsupported_attachment_field:source",
      ],
      [
        refused(withRecord({ senderThreadId: "src-other" })),
        "unknown_context_record_field:senderThreadId",
      ],
      [
        refused(
          rebuild(
            source,
            onType("thread.created", (t) => ({
              ...t,
              lineage: { ...(t.lineage as object), forkPoint: "src-other" },
            })),
          ),
        ),
        "unknown_lineage_field:forkPoint",
      ],
      [refused(source, { lifecycle: "hidden" as never }), "invalid_lifecycle_policy"],
      [refused(source, { workspace: "keep" as never }), "invalid_workspace_policy"],
      [
        refused(
          rebuild(
            source,
            userItem((i) => ({ ...i, futureField: 1 })),
          ),
        ),
        "unknown_turn_item_field:futureField",
      ],
      [
        refused(
          rebuild(
            source,
            userItem((i) => ({ ...i, type: "proposed_plan" })),
          ),
        ),
        "unsupported_turn_item_type:proposed_plan",
      ],
      [
        refused(
          rebuild(
            source,
            onType("message.updated", (m) =>
              m.context ? { ...m, context: { version: 1, records: "x" } } : m,
            ),
          ),
        ),
        "invalid_context",
      ],
      [
        refused(
          rebuild(
            source,
            onType("message.updated", (m) =>
              m.context ? { ...m, context: { ...context, future: 1 } } : m,
            ),
          ),
        ),
        "unknown_context_field:future",
      ],
      [
        refused(
          rebuild(
            source,
            userItem((i) => ({
              ...i,
              attachments: [{ ...image, name: "other.jpg", mimeType: "image/jpeg" }],
            })),
          ),
        ),
        "ambiguous_attachment_reference",
      ],
      [
        refused(
          rebuild(source, (e) =>
            e.type === "turn-item.updated" && e.payload.type === "reasoning"
              ? { ...e, payload: { ...e.payload, messageId: "src-msg-user" } }
              : e,
          ),
        ),
        "unsupported_reasoning_fields",
      ],
      [
        refused(
          rebuild(source, (e) =>
            e.type === "message.updated" ? { ...e, threadId: "src-other" } : e,
          ),
        ),
        "unmapped_event_thread",
      ],
    );
    for (const [result, reason] of cases) assert.deepEqual(result, { refused: reason });
    // Preserve policies copy lifecycle and workspace exactly and record no transformation.
    const kept = mapped(source, { lifecycle: "preserve", workspace: "preserve" });
    const thread = kept.plan.events.at(-1)!.payload as {
      archivedAt: unknown;
      worktreePath: unknown;
    };
    assert.equal(DateTime.formatIso(thread.archivedAt as DateTime.Utc), at(4));
    assert.equal(thread.worktreePath, "/source/checkout");
    assert.deepEqual(kept.provenance.transformations, []);
  }).pipe(Effect.provide(layers)),
);
