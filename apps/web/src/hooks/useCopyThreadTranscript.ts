import type { OrchestrationReadableThreadTranscript, ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback } from "react";

import { loadThreadTranscript } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { writeTextToClipboard } from "./useCopyToClipboard";

interface CopyReadableThreadTranscriptInput {
  readonly threadRef: ScopedThreadRef;
  readonly loadTranscript: (
    threadRef: ScopedThreadRef,
  ) => Promise<Pick<OrchestrationReadableThreadTranscript, "markdown" | "messageCount"> | null>;
  readonly writeClipboard: (value: string, target: string) => Promise<boolean>;
  readonly onSuccess: (messageCount: number) => void;
  readonly onError: (error: unknown) => void;
}

/** One fresh server read per invocation; `null` means the command was interrupted. */
export async function copyReadableThreadTranscript(
  input: CopyReadableThreadTranscriptInput,
): Promise<boolean> {
  try {
    const transcript = await input.loadTranscript(input.threadRef);
    if (transcript === null) return false;
    const copied = await input.writeClipboard(transcript.markdown, "readable chat transcript");
    if (!copied) return false;
    input.onSuccess(transcript.messageCount);
    return true;
  } catch (error) {
    input.onError(error);
    return false;
  }
}

export function readableTranscriptCopyFailure(error: unknown): {
  readonly title: string;
  readonly description: string;
} {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "EnvironmentPayloadTooLargeError"
  ) {
    return {
      title: "Transcript too large",
      description: "This transcript is too large to copy.",
    };
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "EnvironmentResourceNotFoundError"
  ) {
    return {
      title: "Transcript unavailable",
      description: "This thread is no longer available.",
    };
  }
  return {
    title: "Failed to copy transcript",
    description:
      error instanceof Error && error.message.trim().length > 0
        ? error.message
        : "The readable transcript could not be copied.",
  };
}

export function useCopyThreadTranscript(): (threadRef: ScopedThreadRef) => Promise<boolean> {
  const runLoadThreadTranscript = useAtomCommand(loadThreadTranscript, {
    reportFailure: false,
    reportDefect: false,
  });
  const loadTranscript = useCallback(
    async (threadRef: ScopedThreadRef) => {
      const result = await runLoadThreadTranscript({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
      if (result._tag === "Success") return result.value;
      if (isAtomCommandInterrupted(result)) return null;
      throw squashAtomCommandFailure(result);
    },
    [runLoadThreadTranscript],
  );

  return useCallback(
    (threadRef: ScopedThreadRef) =>
      copyReadableThreadTranscript({
        threadRef,
        loadTranscript,
        writeClipboard: writeTextToClipboard,
        onSuccess: (messageCount) => {
          toastManager.add({
            type: "success",
            title: "Transcript copied",
            description: `Copied ${messageCount} readable ${messageCount === 1 ? "message" : "messages"}.`,
          });
        },
        onError: (error) => {
          console.error(error);
          const copy = readableTranscriptCopyFailure(error);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: copy.title,
              description: copy.description,
            }),
          );
        },
      }),
    [loadTranscript],
  );
}
