import { describe, expect, it } from "vite-plus/test";

import {
  MessageId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";

import type { ProviderGroup } from "../../lib/modelOptions";
import { resolveThreadProviderGroups } from "./thread-provider-groups";

const providerGroups: ReadonlyArray<ProviderGroup> = [
  { providerKey: "codex", providerLabel: "Codex", models: [] },
  { providerKey: "claude", providerLabel: "Claude", models: [] },
];

type ThreadProviderSelectionState = Pick<
  OrchestrationThreadShell,
  "forkedFrom" | "latestTurn" | "latestUserMessageAt" | "modelSelection" | "session"
>;

function thread(
  overrides: Partial<ThreadProviderSelectionState> = {},
): ThreadProviderSelectionState {
  return {
    forkedFrom: {
      threadId: ThreadId.make("source"),
      messageId: MessageId.make("source-response"),
    },
    latestTurn: null,
    latestUserMessageAt: null,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    session: null,
    ...overrides,
  };
}

describe("mobile thread provider groups", () => {
  it("offers every runnable provider to a fresh fork", () => {
    expect(resolveThreadProviderGroups(thread(), providerGroups, 0)).toEqual(providerGroups);
  });

  it("locks a fresh fork to its current provider while a submission is queued", () => {
    expect(resolveThreadProviderGroups(thread(), providerGroups, 1)).toEqual([providerGroups[0]]);
  });

  it.each([
    ["ordinary or imported thread", { forkedFrom: undefined }],
    ["fork with a real user submission", { latestUserMessageAt: "2026-09-15T00:00:00.000Z" }],
    [
      "fork with a real turn",
      {
        latestTurn: {
          turnId: TurnId.make("turn"),
          state: "completed" as const,
          requestedAt: "2026-09-15T00:00:00.000Z",
          startedAt: "2026-09-15T00:00:01.000Z",
          completedAt: "2026-09-15T00:00:02.000Z",
          assistantMessageId: MessageId.make("answer"),
        },
      },
    ],
    [
      "fork with a provider session",
      {
        session: {
          threadId: ThreadId.make("fork"),
          status: "error" as const,
          providerName: "codex",
          runtimeMode: "approval-required" as const,
          activeTurnId: null,
          lastError: "Authentication failed",
          updatedAt: "2026-09-15T00:00:00.000Z",
        },
      },
    ],
  ])("keeps %s on its existing provider", (_label, overrides) => {
    expect(resolveThreadProviderGroups(thread(overrides), providerGroups, 0)).toEqual([
      providerGroups[0],
    ]);
  });
});
