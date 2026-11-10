// Offline coverage measurement only: reads pinned legacy and staged stores, writes nothing.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Offline pin checks stream file digests without a runtime service.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Offline pin checks stream file digests without a runtime service.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import { OrchestrationV2DomainEventJson, ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { captureLegacyBaseline } from "./legacyRehearsalBaseline.ts";
import { mapRecoveryPlan, type RecoveryMappingOptions } from "./legacyRecoveryMapping.ts";
import { buildLegacySnapshotPlan } from "./legacySnapshotPlan.ts";
import { fingerprint, type SandboxPlan } from "./SandboxHistoryImport.ts";

/** Labelled technical variants, not adopted product choices. */
const COVERAGE_VARIANTS = [
  { lifecycle: "preserve", workspace: "preserve" },
  { lifecycle: "preserve", workspace: "detach" },
  { lifecycle: "visible", workspace: "preserve" },
  { lifecycle: "visible", workspace: "detach" },
] as const;

/** Streams each file's SHA-256 so multi-GB inputs never load into memory. */
export function hashFiles(paths: ReadonlyArray<string>): Record<string, string | null> {
  return Object.fromEntries(
    paths.map((path) => {
      if (!NodeFS.existsSync(path)) return [path, null];
      const hash = NodeCrypto.createHash("sha256");
      const fd = NodeFS.openSync(path, "r");
      try {
        const buffer = Buffer.alloc(1 << 20);
        for (let read = 0; (read = NodeFS.readSync(fd, buffer, 0, buffer.length, null)) > 0;)
          hash.update(buffer.subarray(0, read));
      } finally {
        NodeFS.closeSync(fd);
      }
      return [path, hash.digest("hex")];
    }),
  );
}

/** Every pinned path must exist and match; extra or missing pins are a mismatch. */
function pinMismatches(pins: Readonly<Record<string, string>>) {
  const actual = hashFiles(Object.keys(pins));
  return Object.entries(pins).flatMap(([path, expected]) =>
    actual[path] === expected ? [] : [{ path, expected, actual: actual[path] ?? null }],
  );
}

const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson);
const jsonLength = (value: string | null, pick: (parsed: any) => unknown) => {
  const picked = value === null ? undefined : pick(JSON.parse(value));
  return Array.isArray(picked) ? picked.length : 0;
};
const syntheticProject = (store: string, projectId: string) =>
  ProjectId.make(
    `rcv-project-${NodeCrypto.createHash("sha256")
      .update(JSON.stringify([store, projectId]))
      .digest("hex")
      .slice(0, 24)}`,
  );
function mappedCounts(plan: SandboxPlan) {
  const messages = plan.events.flatMap((e) => (e.type === "message.updated" ? [e.payload] : []));
  return {
    messages: messages.length,
    reasoning: plan.events.filter(
      (e) => e.type === "turn-item.updated" && e.payload.type === "reasoning",
    ).length,
    attachments: messages.reduce((n, m) => n + m.attachments.length, 0),
    contextRecords: messages.reduce((n, m) => n + (m.context?.records.length ?? 0), 0),
  };
}

export interface CoverageInput {
  legacy: NodeSqlite.DatabaseSync;
  staging: NodeSqlite.DatabaseSync;
  sourceStoreId: string;
  sourceSnapshotSha256: string;
}

export function measureRecoveryCoverage(input: CoverageInput) {
  const baseline = captureLegacyBaseline(input.legacy);
  const lifecycles = new Map(
    input.legacy
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
  const sourceThreadIds = new Set(baseline.threads.map((t) => t.thread_id));
  const stagedThreadIds = input.staging
    .prepare(
      "SELECT DISTINCT stream_id FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread'",
    )
    .all()
    .map((row) => String(row.stream_id));
  const selectStaged = input.staging.prepare(
    "SELECT event_id,stream_id,event_type,occurred_at,payload_json FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread' AND stream_id=? ORDER BY sequence",
  );
  const threads = baseline.threads.map((thread) => {
    const messages = baseline.messages.filter((m) => m.thread_id === thread.thread_id);
    const source = {
      messages: messages.filter((m) => m.role !== "reasoning").length,
      reasoning: messages.filter((m) => m.role === "reasoning").length,
      attachments: messages.reduce((n, m) => n + jsonLength(m.attachments_json, (v) => v), 0),
      contextRecords: messages.reduce(
        (n, m) => n + jsonLength(m.context_json, (v) => v?.records),
        0,
      ),
    };
    const lifecycle = lifecycles.get(thread.thread_id);
    // Per-thread lifecycle lets receipts recount deleted/archived instead of trusting totals.
    const row = {
      sourceThreadId: thread.thread_id,
      source,
      lifecycle: lifecycle
        ? { deleted: lifecycle.deletedAt !== null, archived: lifecycle.archivedAt !== null }
        : null,
    };
    const raw = selectStaged.all(thread.thread_id);
    if (raw.length === 0) return { ...row, builder: { refused: "missing_staged_events" } };
    let staged;
    try {
      staged = raw.map((event) =>
        decodeEvent({
          id: event.event_id,
          threadId: event.stream_id,
          type: event.event_type,
          occurredAt: event.occurred_at,
          payload: JSON.parse(String(event.payload_json)),
        }),
      );
    } catch {
      return { ...row, builder: { refused: "invalid_staged_event" } };
    }
    if (!lifecycle) return { ...row, builder: { refused: "missing_source_lifecycle" } };
    // Coverage never applies a plan, so no target baseline exists; 0 is recorded as such.
    const built = buildLegacySnapshotPlan({
      thread,
      sourceLifecycle: lifecycle,
      messages,
      staged,
      sourceSnapshotSha256: input.sourceSnapshotSha256,
      targetBaselineSequence: 0,
    });
    if ("refused" in built) return { ...row, builder: { refused: built.refused } };
    const projectMap = {
      [built.plan.targetProjectId]: syntheticProject(
        input.sourceStoreId,
        built.plan.targetProjectId,
      ),
    };
    return {
      ...row,
      builder: { planDigest: built.plan.digest },
      variants: COVERAGE_VARIANTS.map((variant) => {
        const label = `${variant.lifecycle}/${variant.workspace}`;
        const options: RecoveryMappingOptions = {
          sourceStoreId: input.sourceStoreId,
          projectMap,
          ...variant,
        };
        const mapped = mapRecoveryPlan(built.plan, options);
        return "refused" in mapped
          ? { variant: label, refused: mapped.refused }
          : {
              variant: label,
              planDigest: mapped.plan.digest,
              provenanceDigest: mapped.provenance.provenanceDigest,
              mapped: mappedCounts(mapped.plan),
            };
      }),
    };
  });

  const reasons = (pick: (t: (typeof threads)[number]) => string | undefined) =>
    threads.reduce<Record<string, number>>((acc, thread) => {
      const reason = pick(thread);
      if (reason) acc[reason] = (acc[reason] ?? 0) + 1;
      return acc;
    }, {});
  const builderRefused = reasons((t) => ("refused" in t.builder ? t.builder.refused : undefined));
  const variants = COVERAGE_VARIANTS.map(({ lifecycle, workspace }) => {
    const label = `${lifecycle}/${workspace}`;
    const results = threads.map((t) =>
      "variants" in t ? t.variants?.find((v) => v.variant === label) : undefined,
    );
    const mapped = results.filter((r) => r !== undefined && !("refused" in r)).length;
    return {
      variant: label,
      mappedThreads: mapped,
      mapperRefused: reasons((t) => {
        const r = "variants" in t ? t.variants?.find((v) => v.variant === label) : undefined;
        return r && "refused" in r ? r.refused : undefined;
      }),
      complete: threads.length > 0 && mapped === threads.length,
    };
  });
  const builderRefusedCount = Object.values(builderRefused).reduce((a, b) => a + b, 0);
  const unexpectedStagedThreads = stagedThreadIds.filter((id) => !sourceThreadIds.has(id)).length;
  const orphanMessages = baseline.messages.filter((m) => !sourceThreadIds.has(m.thread_id)).length;
  const accountedExactly =
    sourceThreadIds.size === baseline.threads.length &&
    threads.length === baseline.threads.length &&
    unexpectedStagedThreads === 0 &&
    orphanMessages === 0 &&
    variants.every(
      (v) =>
        v.mappedThreads +
          Object.values(v.mapperRefused).reduce((a, b) => a + b, 0) +
          builderRefusedCount ===
        threads.length,
    );
  return {
    summary: {
      sourceStoreId: input.sourceStoreId,
      sourceThreads: baseline.threads.length,
      sourceMessages: baseline.messages.length,
      // Soft-deleted, archived and message-less threads are measured, never filtered out.
      sourceDeletedThreads: threads.filter((t) => t.lifecycle?.deleted).length,
      sourceArchivedThreads: threads.filter((t) => t.lifecycle?.archived).length,
      sourceEmptyThreads: threads.filter((t) => t.source.messages + t.source.reasoning === 0)
        .length,
      builtThreads: threads.length - builderRefusedCount,
      builderRefused,
      variants,
      unexpectedStagedThreads,
      orphanMessages,
      accountedExactly,
      // An empty capture is its own outcome, never a vacuous pass.
      emptySource: baseline.threads.length === 0,
      // Evidence is not completeness: any refusal or an empty capture keeps this false.
      complete: accountedExactly && variants.every((v) => v.complete),
    },
    threads,
  };
}

const sidecars = (path: string) => [path, `${path}-wal`, `${path}-shm`];

/**
 * Pins must name exactly the legacy and staging DB/WAL/SHM sets, checked before and after.
 * Both stores open read-only and never immutable, so a nonempty legacy WAL is honoured.
 */
export function runCoverageFromFiles(input: {
  legacyPath: string;
  stagingPath: string;
  pins: Readonly<Record<string, string>>;
  sourceStoreId: string;
}) {
  const required = [...sidecars(input.legacyPath), ...sidecars(input.stagingPath)];
  const unpinned = required.filter((path) => !(path in input.pins));
  const extra = Object.keys(input.pins).filter((path) => !required.includes(path));
  if (unpinned.length || extra.length)
    return { status: "pin_set_mismatch" as const, unpinned, extra };
  const before = pinMismatches(input.pins);
  if (before.length) return { status: "pin_mismatch_before" as const, mismatches: before };
  const legacy = new NodeSqlite.DatabaseSync(input.legacyPath, { readOnly: true });
  const staging = new NodeSqlite.DatabaseSync(input.stagingPath, { readOnly: true });
  let coverage;
  try {
    coverage = measureRecoveryCoverage({
      legacy,
      staging,
      sourceStoreId: input.sourceStoreId,
      // Keyed by role, not mount path, so the digest is stable across sandboxes.
      sourceSnapshotSha256: fingerprint(
        Object.fromEntries(
          sidecars(input.legacyPath).map((path, i) => [["db", "wal", "shm"][i], input.pins[path]]),
        ),
      ),
    });
  } finally {
    legacy.close();
    staging.close();
  }
  const after = pinMismatches(input.pins);
  if (after.length) return { status: "pin_mismatch_after" as const, mismatches: after };
  return {
    status: coverage.summary.complete ? ("complete" as const) : ("incomplete" as const),
    ...coverage,
  };
}
