// mutation-check: characterisation
// Existing internal event semantics, not a supported external history-import API.
import { assert, it } from "@effect/vitest";
import { EventId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Persistence from "../../persistence/Sqlite.ts";
import * as EventStore from "../EventStore.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as EventSink from "../EventSink.ts";
import * as Legacy from "./LegacyV1ThreadImporter.ts";

const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(Persistence.layerMemory),
);
const sink = EventSink.layer.pipe(Layer.provide(stores));
const layers = Layer.mergeAll(
  stores,
  sink,
  Legacy.layer.pipe(Layer.provide(Layer.mergeAll(stores, sink))),
);

it.effect(
  "internal metadata event preserves supplied recency and unrelated threads; event collisions roll back the batch",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const legacy = yield* Legacy.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* EventSink.EventSinkV2;
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('project','Project','/fixture','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
      for (const id of ["recovered", "unrelated"])
        yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,created_at,updated_at) VALUES(${id},'project','Keep title','{"instanceId":"codex","model":"gpt-5.4"}','full-access','default','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
      yield* legacy.reconcileShells;
      const id = ThreadId.make("recovered");
      const original = yield* projections.getThreadProjection(id);
      const unrelated = yield* projections.getThreadProjection(ThreadId.make("unrelated"));
      const recoveredTime = DateTime.makeUnsafe("2026-02-02T03:04:05.000Z");
      const event = {
        id: EventId.make("fixture:metadata"),
        type: "thread.metadata-updated" as const,
        threadId: id,
        occurredAt: recoveredTime,
        payload: { ...original.thread, updatedAt: recoveredTime },
      };
      yield* events.write({ events: [event] });
      const preserved = yield* projections.getThreadProjection(id);
      assert.equal(
        DateTime.formatIso(preserved.thread.updatedAt),
        DateTime.formatIso(recoveredTime),
      );
      assert.deepEqual(
        yield* projections.getThreadProjection(ThreadId.make("unrelated")),
        unrelated,
      );
      const count = (yield* sql`SELECT count(*) AS n FROM orchestration_events`)[0]?.n;
      const conflict = yield* events
        .write({
          events: [
            {
              ...event,
              id: EventId.make("fixture:before-conflict"),
              payload: { ...preserved.thread, title: "Must roll back" },
            },
            event,
          ],
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(conflict));
      assert.deepEqual(yield* projections.getThreadProjection(id), preserved);
      assert.equal((yield* sql`SELECT count(*) AS n FROM orchestration_events`)[0]?.n, count);
      const repeat = yield* events.write({ events: [event] }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(repeat));
    }).pipe(Effect.provide(layers)),
);
