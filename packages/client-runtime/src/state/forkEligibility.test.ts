import { describe, expect, it } from "vite-plus/test";
import {
  CheckpointRef,
  MessageId,
  TurnId,
  type OrchestrationCheckpointSummary,
} from "@t3tools/contracts";

import { deriveForkableAssistantMessageIds } from "./forkEligibility.ts";

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
  it("keeps completed terminal responses and excludes failed or missing responses", () => {
    expect([
      ...deriveForkableAssistantMessageIds([
        checkpoint("ready-response", "ready"),
        checkpoint("missing-checkpoint-response", "missing"),
        checkpoint("failed-response", "error"),
        checkpoint(null, "ready"),
      ]),
    ]).toEqual([MessageId.make("ready-response"), MessageId.make("missing-checkpoint-response")]);
  });
});
