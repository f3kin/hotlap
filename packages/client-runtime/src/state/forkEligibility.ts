import type { MessageId, OrchestrationCheckpointSummary } from "@t3tools/contracts";

/**
 * Checkpoint summaries are the bounded per-turn completion evidence already
 * carried by both clients. A missing workspace checkpoint still represents a
 * completed provider response; an error does not.
 */
export function deriveForkableAssistantMessageIds(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
): ReadonlySet<MessageId> {
  const messageIds = new Set<MessageId>();
  for (const checkpoint of checkpoints) {
    if (checkpoint.status !== "error" && checkpoint.assistantMessageId !== null) {
      messageIds.add(checkpoint.assistantMessageId);
    }
  }
  return messageIds;
}
