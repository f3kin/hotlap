// Offline fixture integration only: rewrites a verified source-faithful plan into new
// recovery identities so same-ID official history can never be overwritten or merged.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Pure offline identity derivation uses a synchronous digest without a runtime service.
import * as NodeCrypto from "node:crypto";
import {
  ChatAttachmentId,
  PastedTextAttachmentSource,
  SnapShotSource,
  MessageId,
  ThreadId,
  TurnItemId,
  type ChatAttachment,
  type OrchestrationV2DomainEvent,
  type ProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { attachmentRelativePath, createDeterministicAttachmentId } from "../attachmentStore.ts";
import { fingerprint, makeSandboxPlan, type SandboxPlan } from "./SandboxHistoryImport.ts";

export interface RecoveryMappingOptions {
  /** Stable namespace of the immutable source store; not its snapshot hash. */
  sourceStoreId: string;
  /** Source project id to a pre-existing target recovery project. */
  projectMap: Readonly<Record<string, ProjectId>>;
  /** "visible" clears source lifecycle state so recovered history is readable. */
  lifecycle: "preserve" | "visible";
  /** "detach" drops the executable worktree path so recovery never points at a checkout. */
  workspace: "preserve" | "detach";
}
export interface RecoveryProvenance {
  sourceStoreId: string;
  sourceSnapshotSha256: string;
  sourceThreadId: string;
  sourcePlanDigest: string;
  sourceEventIds: string[];
  targetPlanDigest: string;
  targetBaselineSequence: number;
  options: RecoveryMappingOptions;
  entities: Array<{
    kind: "project" | "thread" | "message" | "turn-item";
    sourceId: string;
    targetId: string;
  }>;
  attachments: Array<{
    sourceAttachmentId: string;
    targetAttachmentId: string;
    sourceRelativePath: string;
    targetRelativePath: string;
  }>;
  transformations: Array<{
    entity: string;
    field: string;
    sourceValue: unknown;
    targetValue: unknown;
  }>;
  provenanceDigest: string;
}
export type RecoveryMappingResult =
  | { plan: SandboxPlan; provenance: RecoveryProvenance }
  | { refused: string };

function recoveryEntityId(kind: string, sourceStoreId: string, sourceId: string): string {
  const hash = NodeCrypto.createHash("sha256")
    .update(JSON.stringify([kind, sourceStoreId, sourceId]))
    .digest("hex");
  return `rcv-${hash.slice(0, 24)}`;
}

const empty = (value: unknown) =>
  value === undefined || value === null || (Array.isArray(value) && value.length === 0);
const THREAD_COPY = [
  "createdBy",
  "creationSource",
  "title",
  "providerInstanceId",
  "modelSelection",
  "runtimeMode",
  "interactionMode",
  "historyOrigin",
  "createdAt",
  "updatedAt",
];
const THREAD_LIFECYCLE = [
  "archivedAt",
  "deletedAt",
  "settledOverride",
  "settledAt",
  "unsettledAt",
  "snoozedUntil",
  "snoozedAt",
  "lastSnoozeWakeAt",
  "pinnedAt",
  "autoSettleDisabledAt",
  "lastVisitedAt",
];
const THREAD_MUST_BE_EMPTY = [
  "activeProviderThreadId",
  "forkedFrom",
  "linkOrigin",
  "delegatedFrom",
  "pullRequests",
  "linkedPullRequest",
  "branchPullRequest",
  "limitRecovery",
  "guestShare",
  "titleRegeneration",
  "rollbackRequestId",
  "rollbackFailure",
  "pinOrderKey",
  "activeOrderKey",
  "opens",
];
const RUNTIME_LINKS = ["runId", "nodeId"];
const ITEM_RUNTIME_LINKS = [
  ...RUNTIME_LINKS,
  "providerThreadId",
  "providerTurnId",
  "nativeItemRef",
  "parentItemId",
];
const MESSAGE_COPY = [
  "createdBy",
  "creationSource",
  "role",
  "text",
  "streaming",
  "createdAt",
  "updatedAt",
  "workflowScript",
  "idleCompaction",
];
const MESSAGE_MUST_BE_EMPTY = [
  "notification",
  "scheduledTaskId",
  "senderThreadId",
  "delegatedCompletion",
];
const ITEM_COPY = [
  "type",
  "ordinal",
  "status",
  "title",
  "startedAt",
  "completedAt",
  "updatedAt",
  "text",
  "textOmitted",
  "streaming",
];
const ITEM_COPY_BY_TYPE: Record<string, string[]> = {
  user_message: ["createdBy", "creationSource", "inputIntent", "workflowScript", "idleCompaction"],
  assistant_message: [],
  reasoning: [],
};
const ITEM_MUST_BE_EMPTY = [
  "deferredWork",
  "toolNonExecutionKind",
  "toolSurface",
  "toolIcon",
  "toolSource",
  "scheduledTaskId",
  "senderThreadId",
];

// Human content at exact, validated paths only: a string there may equal an old ID by
// chance. Payload-level text/title; attachment name and shape-validated source; context
// record label and name. Every other subtree, however its keys are named, is scanned.
const PAYLOAD_CONTENT_KEYS = ["text", "title"];
const ATTACHMENT_CONTENT_KEYS = ["name", "source"];
const CONTEXT_RECORD_CONTENT_KEYS = ["label", "name"];
const omit = (value: object, keys: ReadonlyArray<string>) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
function scannedPayload(payload: Record<string, unknown>) {
  const scanned = omit(payload, PAYLOAD_CONTENT_KEYS);
  if (Array.isArray(payload.attachments))
    scanned.attachments = payload.attachments.map((a: object) => omit(a, ATTACHMENT_CONTENT_KEYS));
  const context = payload.context as { records?: unknown } | undefined;
  if (context && Array.isArray(context.records))
    scanned.context = {
      ...context,
      records: context.records.map((r: object) => omit(r, CONTEXT_RECORD_CONTENT_KEYS)),
    };
  return scanned;
}

// Nested closed worlds: a spread copy must never carry a key nobody reviewed.
const ATTACHMENT_KEYS = ["type", "id", "name", "mimeType", "sizeBytes"];
const CONTEXT_RECORD_KEYS = [
  "version",
  "contextId",
  "label",
  "kind",
  "attachmentId",
  "name",
  "mimeType",
  "sizeBytes",
];
const LINEAGE_KEYS = ["parentThreadId", "relationshipToParent", "rootThreadId"];

// Attachment sources describe the captured app or a paste; they hold no T3 history
// references, so a value is kept verbatim only when it is exactly the contract shape
// for its attachment type, with no excess or altered field at any depth.
function exactContractShape(
  schema: typeof SnapShotSource | typeof PastedTextAttachmentSource,
  value: unknown,
) {
  try {
    const decoded = Schema.decodeUnknownSync(schema)(value, {
      onExcessProperty: "error",
    });
    return fingerprint(decoded) === fingerprint(value);
  } catch {
    return false;
  }
}

class Refusal {
  constructor(readonly reason: string) {}
}
const refuse = (reason: string): never => {
  throw new Refusal(reason);
};

/** Closed world: every key is copied, mapped, policy-controlled or required empty. */
function closedKeys(
  entity: string,
  value: object,
  handled: ReadonlyArray<string>,
  mustBeEmpty: ReadonlyArray<string>,
) {
  for (const [key, entry] of Object.entries(value)) {
    if (mustBeEmpty.includes(key)) {
      if (!empty(entry)) refuse(`unsupported_${entity}_field:${key}`);
    } else if (!handled.includes(key)) refuse(`unknown_${entity}_field:${key}`);
  }
}

// Checks the input is an untampered builder plan, rebuilding its digest from source event ids.
function verifySourcePlan(plan: SandboxPlan) {
  if (plan.sourceEventIds.length !== plan.events.length) return false;
  const rebuilt = makeSandboxPlan({
    sourceSnapshotSha256: plan.sourceSnapshotSha256,
    sourceThreadId: plan.sourceThreadId,
    targetThreadId: plan.targetThreadId,
    targetProjectId: plan.targetProjectId,
    targetBaselineSequence: plan.targetBaselineSequence,
    events: plan.events.map(
      (event, index) => ({ ...event, id: plan.sourceEventIds[index]! }) as typeof event,
    ),
  });
  return rebuilt.digest === plan.digest && fingerprint(rebuilt.events) === fingerprint(plan.events);
}

export function mapRecoveryPlan(
  source: SandboxPlan,
  options: RecoveryMappingOptions,
): RecoveryMappingResult {
  try {
    return mapOrThrow(source, options);
  } catch (error) {
    if (error instanceof Refusal) return { refused: error.reason };
    throw error;
  }
}

function mapOrThrow(source: SandboxPlan, options: RecoveryMappingOptions) {
  if (!/^[a-z0-9-]{1,40}$/.test(options.sourceStoreId)) refuse("invalid_source_store_id");
  if (!["preserve", "visible"].includes(options.lifecycle)) refuse("invalid_lifecycle_policy");
  if (!["preserve", "detach"].includes(options.workspace)) refuse("invalid_workspace_policy");
  if (!verifySourcePlan(source)) refuse("source_plan_digest_mismatch");
  if (source.targetThreadId !== source.sourceThreadId) refuse("source_plan_already_mapped");
  const store = options.sourceStoreId;
  const sourceThreadId = source.sourceThreadId;
  const targetThreadId = ThreadId.make(recoveryEntityId("thread", store, sourceThreadId));
  const targetProjectId = Object.hasOwn(options.projectMap, source.targetProjectId)
    ? options.projectMap[source.targetProjectId]!
    : refuse("unmapped_project");

  const messageIds = new Map<string, MessageId>();
  const itemIds = new Map<string, TurnItemId>();
  for (const event of source.events) {
    if (event.type === "message.updated")
      messageIds.set(
        event.payload.id,
        MessageId.make(recoveryEntityId("message", store, event.payload.id)),
      );
    if (event.type === "turn-item.updated")
      itemIds.set(
        event.payload.id,
        TurnItemId.make(recoveryEntityId("turn-item", store, event.payload.id)),
      );
  }
  const attachments = new Map<string, RecoveryProvenance["attachments"][number]>();
  const transformations: RecoveryProvenance["transformations"] = [];
  const sourceIds = new Set<string>([
    sourceThreadId,
    source.targetProjectId,
    ...messageIds.keys(),
    ...itemIds.keys(),
  ]);

  const mapAttachment = (attachment: ChatAttachment): ChatAttachment => {
    if (attachment.type !== "image" && attachment.type !== "file")
      refuse("unsupported_attachment_type");
    closedKeys("attachment", attachment, [...ATTACHMENT_KEYS, "source"], []);
    if (
      "source" in attachment &&
      attachment.source !== undefined &&
      !exactContractShape(
        attachment.type === "image" ? SnapShotSource : PastedTextAttachmentSource,
        attachment.source,
      )
    )
      refuse("unsupported_attachment_source");
    const known = attachments.get(attachment.id);
    const targetId =
      known?.targetAttachmentId ??
      createDeterministicAttachmentId(targetThreadId, `recovery:${store}:${attachment.id}`) ??
      refuse("invalid_attachment_owner");
    const mapped = { ...attachment, id: ChatAttachmentId.make(targetId) };
    const sourcePath = attachmentRelativePath(attachment);
    const targetPath = attachmentRelativePath(mapped);
    if (!sourcePath || !targetPath) return refuse("unsupported_attachment_path");
    if (
      known &&
      (known.sourceRelativePath !== sourcePath || known.targetRelativePath !== targetPath)
    )
      refuse("ambiguous_attachment_reference");
    attachments.set(attachment.id, {
      sourceAttachmentId: attachment.id,
      targetAttachmentId: targetId,
      sourceRelativePath: sourcePath,
      targetRelativePath: targetPath,
    });
    sourceIds.add(attachment.id);
    return mapped;
  };
  // Only attachment-bound records are understood; any other kind could point at other history.
  const mapContext = (context: unknown) => {
    if (context === undefined) return undefined;
    const value = context as { version?: unknown; guest?: unknown; records?: unknown };
    if (!value || typeof value !== "object" || !Array.isArray(value.records))
      refuse("invalid_context");
    closedKeys("context", value, ["version", "records"], ["guest"]);
    return {
      ...value,
      records: (value.records as Array<Record<string, unknown>>).map((record) => {
        if (record.kind !== "image" && record.kind !== "file")
          refuse(`unsupported_context_record:${String(record.kind)}`);
        closedKeys("context_record", record, CONTEXT_RECORD_KEYS, []);
        const target = attachments.get(String(record.attachmentId));
        if (!target) return refuse("unmapped_context_attachment");
        return { ...record, attachmentId: target.targetAttachmentId };
      }),
    };
  };

  const mapThread = (
    thread: Extract<OrchestrationV2DomainEvent, { type: "thread.created" }>["payload"],
  ) => {
    closedKeys(
      "thread",
      thread,
      [...THREAD_COPY, ...THREAD_LIFECYCLE, "id", "projectId", "lineage", "branch", "worktreePath"],
      THREAD_MUST_BE_EMPTY,
    );
    closedKeys("lineage", thread.lineage, LINEAGE_KEYS, []);
    if (
      thread.id !== sourceThreadId ||
      thread.lineage.parentThreadId !== null ||
      thread.lineage.relationshipToParent !== null ||
      thread.lineage.rootThreadId !== sourceThreadId
    )
      refuse("unsupported_thread_lineage");
    const mapped: Record<string, unknown> = {
      ...thread,
      id: targetThreadId,
      projectId: targetProjectId,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: targetThreadId },
    };
    if (options.lifecycle === "visible")
      for (const field of THREAD_LIFECYCLE)
        if (!empty(mapped[field])) {
          transformations.push({
            entity: "thread",
            field,
            sourceValue: mapped[field],
            targetValue: null,
          });
          mapped[field] = null;
        }
    if (options.workspace === "detach" && mapped.worktreePath !== null) {
      transformations.push({
        entity: "thread",
        field: "worktreePath",
        sourceValue: mapped.worktreePath,
        targetValue: null,
      });
      mapped.worktreePath = null;
    }
    return mapped as typeof thread;
  };

  const events = source.events.map((event, index): OrchestrationV2DomainEvent => {
    const id = source.sourceEventIds[index]!;
    if (event.threadId !== sourceThreadId) refuse("unmapped_event_thread");
    switch (event.type) {
      case "thread.created":
      case "thread.metadata-updated":
        return {
          ...event,
          id,
          threadId: targetThreadId,
          payload: mapThread(event.payload),
        } as OrchestrationV2DomainEvent;
      case "message.updated": {
        const m = event.payload;
        closedKeys(
          "message",
          m,
          [...MESSAGE_COPY, ...RUNTIME_LINKS, "id", "threadId", "context", "attachments"],
          MESSAGE_MUST_BE_EMPTY,
        );
        if (m.threadId !== sourceThreadId) refuse("unmapped_reference");
        if (m.runId !== null || m.nodeId !== null) refuse("unsupported_runtime_link");
        const mappedAttachments = m.attachments.map(mapAttachment);
        const context = mapContext(m.context);
        return {
          ...event,
          id,
          threadId: targetThreadId,
          payload: {
            ...m,
            id: messageIds.get(m.id)!,
            threadId: targetThreadId,
            attachments: mappedAttachments,
            ...(context === undefined ? {} : { context: context as typeof m.context }),
          },
        };
      }
      case "turn-item.updated": {
        const item = event.payload;
        const extra =
          ITEM_COPY_BY_TYPE[item.type] ?? refuse(`unsupported_turn_item_type:${item.type}`);
        closedKeys(
          "turn_item",
          item,
          [
            ...ITEM_COPY,
            ...ITEM_RUNTIME_LINKS,
            ...extra,
            "id",
            "threadId",
            "messageId",
            "context",
            "attachments",
          ],
          ITEM_MUST_BE_EMPTY,
        );
        if (item.threadId !== sourceThreadId) refuse("unmapped_reference");
        if (ITEM_RUNTIME_LINKS.some((key) => (item as Record<string, unknown>)[key] !== null))
          refuse("unsupported_runtime_link");
        const mapped: Record<string, unknown> = {
          ...item,
          id: itemIds.get(item.id)!,
          threadId: targetThreadId,
        };
        if ("messageId" in item)
          mapped.messageId = messageIds.get(item.messageId) ?? refuse("unmapped_reference");
        if (
          item.type === "reasoning" &&
          ("messageId" in item || "attachments" in item || "context" in item)
        )
          refuse("unsupported_reasoning_fields");
        if ("attachments" in item && item.attachments !== undefined)
          mapped.attachments = item.attachments.map(mapAttachment);
        if ("context" in item && item.context !== undefined)
          mapped.context = mapContext(item.context);
        return { ...event, id, threadId: targetThreadId, payload: mapped as typeof item };
      }
      default:
        return refuse(`unsupported_event:${event.type}`);
    }
  });

  // Defence in depth: no string leaf of the mapped history may still name a source entity.
  const leaves = (value: unknown): string[] =>
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.flatMap(leaves)
        : value !== null && typeof value === "object"
          ? Object.values(value).flatMap(leaves)
          : [];
  if (
    events.some((event) =>
      leaves(scannedPayload(event.payload as Record<string, unknown>)).some((leaf) =>
        sourceIds.has(leaf),
      ),
    )
  )
    refuse("unmapped_reference");

  // Truncated digests must still be unique within the plan, across every entity kind.
  const targetIds = [
    targetThreadId,
    ...messageIds.values(),
    ...itemIds.values(),
    ...[...attachments.values()].map((a) => a.targetAttachmentId),
  ];
  if (new Set(targetIds).size !== targetIds.length) refuse("target_identity_collision");

  const plan = makeSandboxPlan({
    sourceSnapshotSha256: source.sourceSnapshotSha256,
    sourceThreadId,
    targetThreadId,
    targetProjectId,
    targetBaselineSequence: source.targetBaselineSequence,
    events,
  });
  const body = {
    sourceStoreId: store,
    sourceSnapshotSha256: source.sourceSnapshotSha256,
    sourceThreadId,
    sourcePlanDigest: source.digest,
    sourceEventIds: source.sourceEventIds,
    targetPlanDigest: plan.digest,
    targetBaselineSequence: plan.targetBaselineSequence,
    options,
    entities: [
      { kind: "project" as const, sourceId: source.targetProjectId, targetId: targetProjectId },
      { kind: "thread" as const, sourceId: sourceThreadId, targetId: targetThreadId },
      ...[...messageIds].map(([sourceId, targetId]) => ({
        kind: "message" as const,
        sourceId,
        targetId,
      })),
      ...[...itemIds].map(([sourceId, targetId]) => ({
        kind: "turn-item" as const,
        sourceId,
        targetId,
      })),
    ],
    attachments: [...attachments.values()],
    transformations,
  };
  return { plan, provenance: { ...body, provenanceDigest: fingerprint(body) } };
}
