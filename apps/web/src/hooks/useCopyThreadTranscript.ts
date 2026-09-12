import type { OrchestrationReadableThreadTranscript, ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback } from "react";

import { loadThreadTranscript } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import {
  beginDeferredTextClipboardWrite,
  type DeferredTextClipboardWrite,
  writeTextToClipboard,
} from "./useCopyToClipboard";

interface CopyReadableThreadTranscriptInput {
  readonly threadRef: ScopedThreadRef;
  readonly loadTranscript: (
    threadRef: ScopedThreadRef,
  ) => Promise<Pick<OrchestrationReadableThreadTranscript, "markdown" | "messageCount"> | null>;
  readonly beginClipboardWrite?: (target: string) => DeferredTextClipboardWrite | null;
  readonly requestClipboardRetry?: (value: string, messageCount: number) => void;
  readonly writeClipboard: (value: string, target: string) => Promise<boolean>;
  readonly onSuccess: (messageCount: number) => void;
  readonly onError: (error: unknown) => void;
}

/** One fresh server read per invocation; `null` means the command was interrupted. */
export async function copyReadableThreadTranscript(
  input: CopyReadableThreadTranscriptInput,
): Promise<boolean> {
  const target = "readable chat transcript";
  const deferredWrite = input.beginClipboardWrite?.(target) ?? null;
  let transcript: Pick<OrchestrationReadableThreadTranscript, "markdown" | "messageCount"> | null;
  try {
    transcript = await input.loadTranscript(input.threadRef);
  } catch (error) {
    deferredWrite?.cancel(error);
    input.onError(error);
    return false;
  }
  if (transcript === null) {
    deferredWrite?.cancel();
    return false;
  }
  if (
    input.beginClipboardWrite !== undefined &&
    deferredWrite === null &&
    input.requestClipboardRetry
  ) {
    input.requestClipboardRetry(transcript.markdown, transcript.messageCount);
    return false;
  }
  try {
    const copied = deferredWrite
      ? await deferredWrite.commit(transcript.markdown)
      : await input.writeClipboard(transcript.markdown, target);
    if (!copied) return false;
    input.onSuccess(transcript.messageCount);
    return true;
  } catch (error) {
    deferredWrite?.cancel(error);
    if (input.requestClipboardRetry) {
      input.requestClipboardRetry(transcript.markdown, transcript.messageCount);
      return false;
    }
    input.onError(error);
    return false;
  }
}

function addTranscriptCopiedToast(messageCount: number) {
  toastManager.add({
    type: "success",
    title: "Transcript copied",
    description: `Copied ${messageCount} readable ${messageCount === 1 ? "message" : "messages"}.`,
  });
}

function addTranscriptCopyErrorToast(error: unknown) {
  console.error(error);
  const copy = readableTranscriptCopyFailure(error);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: copy.title,
      description: copy.description,
    }),
  );
}

function requestTranscriptClipboardRetry(value: string, messageCount: number) {
  let retryToast: ReturnType<typeof toastManager.add>;
  retryToast = toastManager.add(
    stackedThreadToast({
      type: "info",
      title: "Transcript ready to copy",
      description: "Your browser needs one more click to grant clipboard access.",
      timeout: 30_000,
      actionProps: {
        children: "Copy now",
        onClick: () => {
          // The Clipboard API or execCommand fallback must start inside this click.
          const write = writeTextToClipboard(value, "readable chat transcript");
          toastManager.close(retryToast);
          void write.then((copied) => {
            if (copied) addTranscriptCopiedToast(messageCount);
          }, addTranscriptCopyErrorToast);
        },
      },
    }),
  );
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
        beginClipboardWrite: beginDeferredTextClipboardWrite,
        requestClipboardRetry: requestTranscriptClipboardRetry,
        writeClipboard: writeTextToClipboard,
        onSuccess: addTranscriptCopiedToast,
        onError: addTranscriptCopyErrorToast,
      }),
    [loadTranscript],
  );
}
