import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const at = "2026-09-12T00:00:00.000Z";
const projectId = ProjectId.make("project-1");
const sourceThreadId = ThreadId.make("thread-source");
const sourceMessageId = MessageId.make("assistant-answer");

const withProject = () =>
  projectEvent(createEmptyReadModel(at), {
    sequence: 1,
    eventId: EventId.make("event-project"),
    aggregateKind: "project",
    aggregateId: projectId,
    type: "project.created",
    occurredAt: at,
    commandId: CommandId.make("command-project"),
    causationEventId: null,
    correlationId: CommandId.make("command-project"),
    metadata: {},
    payload: {
      projectId,
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: null,
      scripts: [],
      createdAt: at,
      updatedAt: at,
    },
  });

const forkSource = {
  threadId: sourceThreadId,
  projectId,
  title: "Original",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access" as const,
  interactionMode: "plan" as const,
  branch: "feature",
  worktreePath: "/tmp/project-worktree",
  archivedAt: null,
  busy: false,
  selectedTurn: { state: "completed", assistantMessageId: sourceMessageId },
  messages: [
    {
      id: MessageId.make("user-question"),
      role: "user" as const,
      text: "Question",
      streaming: false,
      createdAt: "2026-09-11T00:00:00.000Z",
    },
    {
      id: sourceMessageId,
      role: "assistant" as const,
      text: "Answer",
      streaming: false,
      createdAt: "2026-09-11T00:01:00.000Z",
    },
  ],
};

it.layer(NodeServices.layer)("thread fork", (it) => {
  it.effect("atomically creates an active inherited thread through the selected response", () =>
    Effect.gen(function* () {
      const readModel = yield* withProject();
      const destination = ThreadId.make("thread-fork");
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.fork",
          commandId: CommandId.make("command-fork"),
          threadId: destination,
          sourceThreadId,
          sourceMessageId,
          createdAt: at,
        },
        readModel,
        forkSource,
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map(({ type }) => type)).toEqual([
        "thread.created",
        "thread.message-sent",
        "thread.message-sent",
      ]);
      expect(events[0]).toMatchObject({
        type: "thread.created",
        payload: {
          title: "Original (fork)",
          modelSelection: forkSource.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "plan",
          branch: "feature",
          worktreePath: "/tmp/project-worktree",
          forkedFrom: { threadId: sourceThreadId, messageId: sourceMessageId },
        },
      });
      expect(events.slice(1)).toMatchObject([
        { payload: { role: "user", text: "Question", turnId: null } },
        { payload: { role: "assistant", text: "Answer", turnId: null } },
      ]);
      expect(events.at(-1)?.type).not.toBe("thread.settled");
    }),
  );

  it.effect("rejects streaming, non-terminal, busy, and missing fork sources", () =>
    Effect.gen(function* () {
      const readModel = yield* withProject();
      const command = {
        type: "thread.fork" as const,
        commandId: CommandId.make("command-invalid-fork"),
        threadId: ThreadId.make("thread-fork"),
        sourceThreadId,
        sourceMessageId,
        createdAt: at,
      };
      for (const source of [
        undefined,
        { ...forkSource, busy: true },
        { ...forkSource, messages: [{ ...forkSource.messages[1]!, streaming: true }] },
        { ...forkSource, selectedTurn: { state: "completed", assistantMessageId: null } },
        {
          ...forkSource,
          messages: [
            forkSource.messages[0]!,
            {
              ...forkSource.messages[1]!,
              text: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS),
            },
          ],
        },
      ]) {
        const failure = yield* decideOrchestrationCommand({
          command,
          readModel,
          ...(source === undefined ? {} : { forkSource: source }),
        }).pipe(Effect.flip);
        expect(failure._tag).toBe("OrchestrationCommandInvariantError");
      }
    }),
  );
});
