import { compareLegacyVisibleItems } from "./legacyRehearsalCheck.ts";
import { buildLegacySnapshotPlan, type SnapshotInput } from "./legacySnapshotPlan.ts";
import { assert, it } from "@effect/vitest";
import { EventId, MessageId, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Persistence from "./Sqlite.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Legacy from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import { applySandboxPlan, makeSandboxPlan } from "./SandboxHistoryImport.ts";

const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(Persistence.layerMemory),
);
const sink = EventSink.layer.pipe(Layer.provide(stores));
const layers = Layer.mergeAll(
  stores,
  sink,
  Legacy.layer.pipe(Layer.provide(Layer.mergeAll(stores, sink))),
);
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const legacy = yield* Legacy.LegacyV1ThreadImporter;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventStore = yield* EventStore.EventStoreV2;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('project','Project','/fixture','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
  yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,created_at,updated_at) VALUES('unrelated','project','Keep me','{"instanceId":"codex","model":"gpt-5.4"}','full-access','default','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
  yield* legacy.reconcileShells;
  const unrelated = yield* projections.getThreadProjection(ThreadId.make("unrelated"));
  const id = ThreadId.make("recovered");
  const time = DateTime.makeUnsafe("2026-02-02T00:00:00.000Z");
  const messageTime = DateTime.makeUnsafe("2026-01-02T00:00:00.000Z");
  const thread = {
    ...unrelated.thread,
    id,
    title: "Recovered",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    updatedAt: time,
  };
  const message = {
    id: MessageId.make("message"),
    threadId: id,
    createdBy: "user" as const,
    creationSource: "server" as const,
    runId: null,
    nodeId: null,
    role: "user" as const,
    text: "Recovered text",
    attachments: [],
    streaming: false,
    createdAt: messageTime,
    updatedAt: messageTime,
  };
  const item = {
    id: TurnItemId.make("item"),
    threadId: id,
    createdBy: "user" as const,
    creationSource: "server" as const,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed" as const,
    title: null,
    startedAt: messageTime,
    completedAt: messageTime,
    updatedAt: messageTime,
    type: "user_message" as const,
    messageId: message.id,
    inputIntent: "turn_start" as const,
    text: message.text,
    attachments: [],
  };
  const plan = makeSandboxPlan({
    sourceSnapshotSha256: "a".repeat(64),
    sourceThreadId: "recovered",
    targetThreadId: id,
    targetProjectId: thread.projectId,
    targetBaselineSequence: yield* eventStore.latestApplicationSequence,
    events: [
      {
        id: EventId.make("source:create"),
        threadId: id,
        type: "thread.created",
        occurredAt: thread.createdAt,
        payload: thread,
      },
      {
        id: EventId.make("source:message"),
        threadId: id,
        type: "message.updated",
        occurredAt: messageTime,
        payload: message,
      },
      {
        id: EventId.make("source:item"),
        threadId: id,
        type: "turn-item.updated",
        occurredAt: messageTime,
        payload: item,
      },
      {
        id: EventId.make("source:metadata"),
        threadId: id,
        type: "thread.metadata-updated",
        occurredAt: time,
        payload: thread,
      },
    ],
  });
  return { sql, projections, eventStore, unrelated, plan, id, time };
});

it.effect(
  "imports a new thread without changing unrelated state, restores recency, and recognises exact replay without writes",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* applySandboxPlan(f.plan);
      const target = yield* f.projections.getThreadProjection(f.id);
      assert.equal(target.messages[0]?.text, "Recovered text");
      assert.equal(DateTime.formatIso(target.thread.updatedAt), DateTime.formatIso(f.time));
      assert.deepEqual(
        yield* f.projections.getThreadProjection(ThreadId.make("unrelated")),
        f.unrelated,
      );
      const before = yield* f.eventStore.latestApplicationSequence;
      assert.equal((yield* applySandboxPlan(f.plan)).status, "already_exact");
      assert.equal(yield* f.eventStore.latestApplicationSequence, before);
    }).pipe(Effect.provide(layers)),
);

it.effect("refuses a tampered source mapping or changed target baseline without writing", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const before = yield* f.eventStore.latestApplicationSequence;
    assert.isTrue(
      Exit.isFailure(
        yield* applySandboxPlan({ ...f.plan, sourceSnapshotSha256: "b".repeat(64) }).pipe(
          Effect.exit,
        ),
      ),
    );
    const changed = makeSandboxPlan({
      ...f.plan,
      targetBaselineSequence: f.plan.targetBaselineSequence - 1,
    });
    assert.isTrue(Exit.isFailure(yield* applySandboxPlan(changed).pipe(Effect.exit)));
    assert.equal(yield* f.eventStore.latestApplicationSequence, before);
  }).pipe(Effect.provide(layers)),
);

it.effect("refuses different content under an already imported thread identity", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* applySandboxPlan(f.plan);
    const before = yield* f.eventStore.latestApplicationSequence;
    const changed = makeSandboxPlan({
      ...f.plan,
      events: f.plan.events.map((event) =>
        event.type === "message.updated"
          ? { ...event, payload: { ...event.payload, text: "Conflicting content" } }
          : event,
      ),
    });
    assert.isTrue(Exit.isFailure(yield* applySandboxPlan(changed).pipe(Effect.exit)));
    assert.equal(yield* f.eventStore.latestApplicationSequence, before);
  }).pipe(Effect.provide(layers)),
);

it.effect("refuses partial threads rather than filling or skipping them", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const sink = yield* EventSink.EventSinkV2;
    yield* sink.write({ events: [f.plan.events[0]!] });
    const before = yield* f.eventStore.latestApplicationSequence;
    assert.isTrue(Exit.isFailure(yield* applySandboxPlan(f.plan).pipe(Effect.exit)));
    assert.equal(yield* f.eventStore.latestApplicationSequence, before);
  }).pipe(Effect.provide(layers)),
);

it.effect("rolls back a mid-batch sink failure and permits a clean retry", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const real = yield* EventSink.EventSinkV2;
    const before = yield* f.eventStore.latestApplicationSequence;
    const failed = yield* applySandboxPlan(f.plan).pipe(
      Effect.provideService(EventSink.EventSinkV2, {
        ...real,
        write: (input) => real.write({ ...input, events: [...input.events, input.events[0]!] }),
      }),
      Effect.exit,
    );
    assert.isTrue(Exit.isFailure(failed));
    assert.equal(yield* f.eventStore.latestApplicationSequence, before);
    assert.equal(
      (yield* f.sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${f.id}`)
        .length,
      0,
    );
    assert.deepEqual(
      yield* f.projections.getThreadProjection(ThreadId.make("unrelated")),
      f.unrelated,
    );
    assert.equal((yield* applySandboxPlan(f.plan)).status, "applied");
  }).pipe(Effect.provide(layers)),
);

it.effect("refuses projection drift even when the completed event manifest is intact", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* applySandboxPlan(f.plan);
    const before = yield* f.eventStore.latestApplicationSequence;
    yield* f.sql`DELETE FROM orchestration_v2_projection_messages WHERE thread_id = ${f.id}`;
    assert.isTrue(Exit.isFailure(yield* applySandboxPlan(f.plan).pipe(Effect.exit)));
    assert.equal(yield* f.eventStore.latestApplicationSequence, before);
  }).pipe(Effect.provide(layers)),
);

it.effect("refuses a message identity collision in an unrelated thread", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const real = yield* EventSink.EventSinkV2;
    const message = f.plan.events.find((e) => e.type === "message.updated")!;
    if (message.type !== "message.updated") return;
    yield* real.write({
      events: [
        {
          ...message,
          id: EventId.make("unrelated-message"),
          threadId: ThreadId.make("unrelated"),
          payload: { ...message.payload, threadId: ThreadId.make("unrelated") },
        },
      ],
    });
    const before = yield* f.eventStore.latestApplicationSequence;
    const plan = makeSandboxPlan({ ...f.plan, targetBaselineSequence: before });
    assert.isTrue(Exit.isFailure(yield* applySandboxPlan(plan).pipe(Effect.exit)));
    assert.equal(yield* f.eventStore.latestApplicationSequence, before);
    assert.equal(
      (yield* f.projections.getThreadProjection(ThreadId.make("unrelated"))).messages.length,
      1,
    );
  }).pipe(Effect.provide(layers)),
);

it.effect("interruption after native writes rolls back the outer transaction before retry", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const real = yield* EventSink.EventSinkV2;
    const before = yield* f.eventStore.latestApplicationSequence;
    const failed = yield* applySandboxPlan(f.plan).pipe(
      Effect.provideService(EventSink.EventSinkV2, {
        ...real,
        write: (input) => real.write(input).pipe(Effect.andThen(Effect.interrupt)),
      }),
      Effect.exit,
    );
    assert.isTrue(Exit.isFailure(failed));
    assert.equal(yield* f.eventStore.latestApplicationSequence, before);
    assert.equal(
      (yield* f.sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${f.id}`)
        .length,
      0,
    );
    assert.equal((yield* applySandboxPlan(f.plan)).status, "applied");
  }).pipe(Effect.provide(layers)),
);

const translationFixture = Effect.gen(function* () {
  const f = yield* fixture;
  const source: SnapshotInput = {
    sourceLifecycle: {
      forkSourceThreadId: null,
      forkSourceMessageId: null,
      archivedAt: null,
      deletedAt: null,
    },
    thread: {
      thread_id: "recovered",
      project_id: "project",
      title: "Recovered",
      branch: null,
      worktree_path: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-02-02T00:00:00.000Z",
    },
    messages: [
      {
        thread_id: "recovered",
        message_id: "message",
        role: "user",
        text: "Recovered text",
        created_at: "2026-01-02T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
        attachments_json: "[]",
        context_json: null,
        is_streaming: 0,
      },
    ],
    staged: f.plan.events,
    sourceSnapshotSha256: "a".repeat(64),
    targetBaselineSequence: f.plan.targetBaselineSequence,
  };
  return { f, source };
});
it.effect(
  "translates only complete final-state snapshots and refuses duplicate updates or oversized threads",
  () =>
    Effect.gen(function* () {
      const { f, source } = yield* translationFixture;
      const good = buildLegacySnapshotPlan(source);
      assert.isTrue("plan" in good);
      if ("plan" in good) assert.equal((yield* applySandboxPlan(good.plan)).status, "applied");
      assert.deepEqual(
        buildLegacySnapshotPlan({ ...source, staged: [...source.staged, source.staged[1]!] }),
        { refused: "duplicate_entity_update" },
      );
      assert.deepEqual(
        buildLegacySnapshotPlan({
          ...source,
          staged: Array.from({ length: 2501 }, () => source.staged[0]!),
        }),
        { refused: "event_limit" },
      );
      assert.deepEqual(
        buildLegacySnapshotPlan({
          ...source,
          messages: source.messages.map((m) => ({ ...m, text: "different source" })),
        }),
        { refused: "source_history_mismatch" },
      );
      assert.deepEqual(
        buildLegacySnapshotPlan({
          ...source,
          messages: source.messages.map((m) => ({ ...m, role: "system" })),
        }),
        { refused: "unsupported_role_or_streaming" },
      );
      assert.deepEqual(
        buildLegacySnapshotPlan({
          ...source,
          staged: source.staged.map((e) =>
            e.type === "turn-item.updated" ? { ...e, payload: { ...e.payload, ordinal: 10 } } : e,
          ),
        }),
        { refused: "unsupported_turn_item" },
      );
      assert.deepEqual(
        buildLegacySnapshotPlan({
          ...source,
          staged: source.staged.map((e) =>
            e.type === "turn-item.updated" && e.payload.type === "user_message"
              ? {
                  ...e,
                  payload: { ...e.payload, type: "assistant_message" as const, streaming: false },
                }
              : e,
          ),
        }),
        { refused: "unsupported_turn_item" },
      );
      assert.deepEqual(
        buildLegacySnapshotPlan({
          ...source,
          staged: source.staged.map((e) =>
            e.type === "message.updated" ? { ...e, payload: { ...e.payload, streaming: true } } : e,
          ),
        }),
        { refused: "unsupported_turn_item" },
      );
      assert.deepEqual(
        buildLegacySnapshotPlan({
          ...source,
          sourceLifecycle: { ...source.sourceLifecycle, forkSourceThreadId: "parent" },
        }),
        { refused: "source_fork_excluded" },
      );
      assert.deepEqual(
        buildLegacySnapshotPlan({
          ...source,
          sourceLifecycle: { ...source.sourceLifecycle, deletedAt: "2026-01-01T00:00:00.000Z" },
        }),
        { refused: "source_lifecycle_mismatch" },
      );
      for (const field of ["startedAt", "completedAt"] as const) {
        assert.deepEqual(
          buildLegacySnapshotPlan({
            ...source,
            staged: source.staged.map((e) =>
              e.type === "turn-item.updated"
                ? {
                    ...e,
                    payload: {
                      ...e.payload,
                      [field]: DateTime.makeUnsafe("2000-01-01T00:00:00.000Z"),
                    },
                  }
                : e,
            ),
          }),
          { refused: "unsupported_turn_item" },
        );
      }
      assert.equal((yield* f.projections.getThreadProjection(f.id)).messages.length, 1);
    }).pipe(Effect.provide(layers)),
);

it.effect(
  "accepts the explicit 2500-event fixture boundary with exact replay and rejects 2501",
  () =>
    Effect.gen(function* () {
      const { f, source } = yield* translationFixture;
      const message = source.staged.find((e) => e.type === "message.updated")!;
      const item = source.staged.find((e) => e.type === "turn-item.updated")!;
      if (
        message.type !== "message.updated" ||
        item.type !== "turn-item.updated" ||
        item.payload.type !== "user_message"
      )
        return;
      const sourceMessages = Array.from({ length: 1249 }, (_, index) => ({
        ...source.messages[0]!,
        message_id: `m${String(index).padStart(4, "0")}`,
      }));
      const pairs = sourceMessages.flatMap((row, index) => [
        {
          ...message,
          id: EventId.make(`m-event-${index}`),
          payload: { ...message.payload, id: MessageId.make(row.message_id) },
        },
        {
          ...item,
          id: EventId.make(`i-event-${index}`),
          payload: {
            ...item.payload,
            id: TurnItemId.make(`i${index}`),
            messageId: MessageId.make(row.message_id),
            ordinal: index + 1,
          },
        },
      ]);
      const staged = [source.staged[0]!, ...pairs, source.staged.at(-1)!];
      const built = buildLegacySnapshotPlan({ ...source, messages: sourceMessages, staged });
      assert.isTrue("plan" in built);
      if ("plan" in built) {
        assert.equal(built.plan.events.length, 2500);
        yield* applySandboxPlan(built.plan);
        assert.equal((yield* f.projections.getThreadProjection(f.id)).messages.length, 1249);
        assert.equal((yield* applySandboxPlan(built.plan)).status, "already_exact");
      }
      assert.deepEqual(
        buildLegacySnapshotPlan({
          ...source,
          messages: sourceMessages,
          staged: [...staged, staged[1]!],
        }),
        { refused: "event_limit" },
      );
    }).pipe(Effect.provide(layers)),
);

it.effect("refuses a fixture plan above the explicit four MiB byte bound without writes", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const huge = "x".repeat(4 * 1024 * 1024);
    const plan = makeSandboxPlan({
      ...f.plan,
      events: f.plan.events.map((e) =>
        e.type === "message.updated" ? { ...e, payload: { ...e.payload, text: huge } } : e,
      ),
    });
    const before = yield* f.eventStore.latestApplicationSequence;
    assert.isTrue(Exit.isFailure(yield* applySandboxPlan(plan).pipe(Effect.exit)));
    assert.equal(yield* f.eventStore.latestApplicationSequence, before);
  }).pipe(Effect.provide(layers)),
);

it.effect("preserves source reasoning as ordered native items without runtime links", () =>
  Effect.gen(function* () {
    const { f, source } = yield* translationFixture;
    const reasoning = {
      ...source.messages[0]!,
      message_id: "aaa-reasoning",
      role: "reasoning",
      text: "Original reasoning",
      updated_at: "2026-01-03T00:00:00.000Z",
    };
    const original = [reasoning, ...source.messages];
    const built = buildLegacySnapshotPlan({ ...source, messages: original });
    assert.isTrue("plan" in built);
    if (!("plan" in built)) return;
    const real = yield* EventSink.EventSinkV2;
    const before = yield* f.eventStore.latestApplicationSequence;
    const interrupted = yield* applySandboxPlan(built.plan).pipe(
      Effect.provideService(EventSink.EventSinkV2, {
        ...real,
        write: (input) => real.write({ ...input, events: [...input.events, input.events[0]!] }),
      }),
      Effect.exit,
    );
    assert.isTrue(Exit.isFailure(interrupted));
    assert.equal(yield* f.eventStore.latestApplicationSequence, before);
    assert.equal(
      (yield* f.sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${f.id}`)
        .length,
      0,
    );
    yield* applySandboxPlan(built.plan);
    const target = yield* f.projections.getThreadProjection(f.id);
    assert.equal(target.messages.length, 1);
    assert.equal(target.visibleTurnItems.length, 2);
    const first = target.visibleTurnItems[0]!.item;
    assert.equal(first.type, "reasoning");
    assert.equal(first.id, "migration:v1:turn-item:aaa-reasoning");
    assert.equal("text" in first ? first.text : null, reasoning.text);
    assert.equal(
      first.startedAt === null ? null : DateTime.formatIso(first.startedAt),
      reasoning.created_at,
    );
    assert.equal(
      first.completedAt === null ? null : DateTime.formatIso(first.completedAt),
      reasoning.updated_at,
    );
    assert.equal(DateTime.formatIso(first.updatedAt), reasoning.updated_at);
    assert.deepEqual(
      [
        first.runId,
        first.nodeId,
        first.providerThreadId,
        first.providerTurnId,
        first.nativeItemRef,
        first.parentItemId,
      ],
      [null, null, null, null, null, null],
    );
    assert.equal(target.visibleTurnItems[1]!.item.ordinal, 2);
    const visible = target.visibleTurnItems.map((row) => row.item);
    assert.isTrue(compareLegacyVisibleItems(original, visible));
    assert.isFalse(compareLegacyVisibleItems(original, visible.slice(1)));
    assert.isFalse(
      compareLegacyVisibleItems(original, [
        { ...first, runId: RunId.make("fabricated") },
        visible[1]!,
      ]),
    );
    assert.isFalse(compareLegacyVisibleItems(original, [...visible].reverse()));
    for (const field of ["startedAt", "completedAt", "updatedAt"] as const)
      assert.isFalse(
        compareLegacyVisibleItems(original, [
          { ...first, [field]: DateTime.makeUnsafe("2000-01-01T00:00:00.000Z") },
          visible[1]!,
        ]),
      );
    assert.isFalse(
      compareLegacyVisibleItems(original, [
        { ...first, id: TurnItemId.make("wrong") },
        visible[1]!,
      ]),
    );
    if (first.type === "reasoning") {
      assert.isFalse(
        compareLegacyVisibleItems(original, [{ ...first, text: "lost original" }, visible[1]!]),
      );
      assert.isFalse(
        compareLegacyVisibleItems(original, [{ ...first, streaming: true }, visible[1]!]),
      );
    }
    for (const changed of [
      { ...reasoning, context_json: "{}" },
      { ...reasoning, attachments_json: '[{"id":"a"}]' },
      { ...reasoning, created_at: "2026-01-02T00:00:00.000001Z" },
    ])
      assert.deepEqual(
        buildLegacySnapshotPlan({ ...source, messages: [changed, ...source.messages] }),
        { refused: "unsupported_reasoning_fields" },
      );
    assert.deepEqual(
      buildLegacySnapshotPlan({ ...source, messages: [reasoning, reasoning, ...source.messages] }),
      { refused: "duplicate_source_identity" },
    );
    assert.equal((yield* applySandboxPlan(built.plan)).status, "already_exact");
  }).pipe(Effect.provide(layers)),
);
