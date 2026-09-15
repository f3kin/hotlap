import type {
  MessageId,
  OrchestrationCheckpointSummary,
  OrchestrationLatestTurn,
  OrchestrationThreadShell,
} from "@t3tools/contracts";
import { isReadOnlyHistoryMessageId } from "@t3tools/contracts";

/**
 * Checkpoint summaries are the bounded per-turn completion evidence already
 * carried by both clients. Checkpoint status describes workspace capture, not
 * whether the provider produced readable terminal output.
 */
export function deriveForkableAssistantMessageIds(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
  latestTurn?: {
    readonly state: OrchestrationLatestTurn["state"];
    readonly assistantMessageId?: OrchestrationLatestTurn["assistantMessageId"];
  } | null,
): ReadonlySet<MessageId> {
  const messageIds = new Set<MessageId>();
  for (const checkpoint of checkpoints) {
    if (checkpoint.assistantMessageId !== null) {
      messageIds.add(checkpoint.assistantMessageId);
    }
  }
  if (
    latestTurn?.assistantMessageId !== null &&
    latestTurn?.assistantMessageId !== undefined &&
    latestTurn.state !== "running"
  ) {
    messageIds.add(latestTurn.assistantMessageId);
  }
  return messageIds;
}

/** Fork history is read-only context, so it must not bind the fresh thread to
 * the source provider. The first real submission closes this selection window. */
export function isForkProviderSelectionUnlocked(
  thread:
    | (Pick<OrchestrationThreadShell, "forkedFrom" | "latestTurn" | "session"> & {
        readonly latestUserMessageAt?: OrchestrationThreadShell["latestUserMessageAt"];
        readonly messages?: ReadonlyArray<{
          readonly id: MessageId;
          readonly role: "user" | "assistant" | "system";
        }>;
      })
    | null
    | undefined,
): boolean {
  return Boolean(
    thread?.forkedFrom !== undefined &&
    thread.latestTurn === null &&
    (thread.latestUserMessageAt === undefined || thread.latestUserMessageAt === null) &&
    thread.session === null &&
    !thread.messages?.some(
      (message) => message.role === "user" && !isReadOnlyHistoryMessageId(message.id),
    ),
  );
}
