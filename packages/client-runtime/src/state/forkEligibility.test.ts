import { describe, expect, it } from "vite-plus/test";
import {
  CheckpointRef,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";

import {
  deriveForkableAssistantMessageIds,
  isForkProviderSelectionUnlocked,
} from "./forkEligibility.ts";

function checkpoint(
  assistantMessageId: string | null,
  status: OrchestrationCheckpointSummary["status"],
): OrchestrationCheckpointSummary {
  return {
    turnId: TurnId.make(`turn-${assistantMessageId ?? "none"}`),
    checkpointTurnCount: 1,
    checkpointRef: CheckpointRef.make("refs/t3/checkpoint"),
    status,
    files: [],
    assistantMessageId: assistantMessageId === null ? null : MessageId.make(assistantMessageId),
    completedAt: "2026-09-12T00:00:00.000Z",
  };
}

describe("deriveForkableAssistantMessageIds", () => {
  it("keeps every terminal response that has readable assistant output", () => {
    expect([
      ...deriveForkableAssistantMessageIds([
        checkpoint("ready-response", "ready"),
        checkpoint("missing-checkpoint-response", "missing"),
        checkpoint("failed-response", "error"),
        checkpoint(null, "ready"),
      ]),
    ]).toEqual([
      MessageId.make("ready-response"),
      MessageId.make("missing-checkpoint-response"),
      MessageId.make("failed-response"),
    ]);
  });

  it("uses the latest terminal response when no checkpoint summary exists", () => {
    expect([
      ...deriveForkableAssistantMessageIds([], {
        state: "interrupted",
        assistantMessageId: MessageId.make("interrupted-response"),
      }),
    ]).toEqual([MessageId.make("interrupted-response")]);
    expect([
      ...deriveForkableAssistantMessageIds([], {
        state: "error",
        assistantMessageId: MessageId.make("error-response"),
      }),
    ]).toEqual([MessageId.make("error-response")]);
    expect([
      ...deriveForkableAssistantMessageIds([], {
        state: "running",
        assistantMessageId: MessageId.make("streaming-response"),
      }),
    ]).toEqual([]);
    expect([
      ...deriveForkableAssistantMessageIds([], {
        state: "completed",
        assistantMessageId: null,
      }),
    ]).toEqual([]);
  });
});

function threadShell(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: ThreadId.make("fork"),
    projectId: ProjectId.make("project"),
    title: "Fork",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    branchPullRequest: null,
    latestTurn: null,
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    forkedFrom: {
      threadId: ThreadId.make("source"),
      messageId: MessageId.make("source-response"),
    },
    ...overrides,
  };
}

describe("isForkProviderSelectionUnlocked", () => {
  it("unlocks only a fresh fork before its first real user submission", () => {
    expect(isForkProviderSelectionUnlocked(threadShell())).toBe(true);
    expect(isForkProviderSelectionUnlocked(threadShell({ forkedFrom: undefined }))).toBe(false);
    expect(
      isForkProviderSelectionUnlocked(
        threadShell({ latestUserMessageAt: "2026-09-12T00:01:00.000Z" }),
      ),
    ).toBe(false);
    expect(
      isForkProviderSelectionUnlocked(
        threadShell({
          session: {
            threadId: ThreadId.make("fork"),
            status: "error",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: "Authentication failed",
            updatedAt: "2026-09-12T00:01:00.000Z",
          },
        }),
      ),
    ).toBe(false);
  });

  it("uses detail messages when the shell has not observed the first fork submission", () => {
    const freshShell = threadShell();

    expect(
      isForkProviderSelectionUnlocked({
        ...freshShell,
        messages: [
          {
            id: MessageId.make("fork-history:fork:0000"),
            role: "user" as const,
          },
        ],
      }),
    ).toBe(true);
    expect(
      isForkProviderSelectionUnlocked({
        ...freshShell,
        messages: [{ id: MessageId.make("first-real-message"), role: "user" as const }],
      }),
    ).toBe(false);
  });
});
