// Shared source-faithful builder fixture for the recovery mapper and coverage tests.
import {
  EventId,
  MessageId,
  OrchestrationV2DomainEvent,
  ProjectId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { SnapshotInput } from "./legacySnapshotPlan.ts";

export const ATTACHMENT = "src-thread-11111111-1111-1111-1111-111111111111";
export const image = {
  type: "image" as const,
  id: ATTACHMENT,
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 10,
  // A valid snapshot source must survive recovery verbatim, nested tree included.
  source: {
    kind: "snap-shot" as const,
    capturedAt: "2026-01-02T00:00:00.000Z",
    appName: "Browser",
    windowTitle: "Docs",
    accessibility: {
      format: "element-tree" as const,
      coordinateSpace: "captured-image" as const,
      imageSize: { width: 10, height: 10 },
      truncated: false,
      root: {
        role: "window",
        bounds: null,
        children: [{ role: "button", name: "Save", bounds: null, children: [] }],
      },
    },
  },
};
export const context = {
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
export const at = (day: number) => `2026-01-0${day}T00:00:00.000Z`;

/** A source-faithful builder input: user (image + context), reasoning, assistant. */
export const sourceInput = (shell: unknown, text: string, baseline: number): SnapshotInput => {
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
