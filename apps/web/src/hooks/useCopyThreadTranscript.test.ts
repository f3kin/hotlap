import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  copyReadableThreadTranscript,
  readableTranscriptCopyFailure,
} from "./useCopyThreadTranscript";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

describe("copyReadableThreadTranscript", () => {
  it("reserves async clipboard access before loading a remote transcript", async () => {
    const order: Array<string> = [];
    const commit = vi.fn(async (value: string) => {
      order.push(`commit:${value}`);
      return true;
    });
    const cancel = vi.fn();

    await copyReadableThreadTranscript({
      threadRef,
      loadTranscript: vi.fn(async () => {
        order.push("load");
        return { markdown: "# Remote", messageCount: 1 };
      }),
      beginClipboardWrite: vi.fn(() => {
        order.push("reserve");
        return { commit, cancel };
      }),
      writeClipboard: vi.fn(),
      onSuccess: vi.fn(),
      onError: vi.fn(),
    });

    expect(order).toEqual(["reserve", "load", "commit:# Remote"]);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("loads a fresh transcript for every copy and writes the returned markdown", async () => {
    const loadTranscript = vi
      .fn()
      .mockResolvedValueOnce({ markdown: "# First", messageCount: 2 })
      .mockResolvedValueOnce({ markdown: "# Second", messageCount: 3 });
    const writeClipboard = vi.fn().mockResolvedValue(true);
    const onSuccess = vi.fn();

    await copyReadableThreadTranscript({
      threadRef,
      loadTranscript,
      writeClipboard,
      onSuccess,
      onError: vi.fn(),
    });
    await copyReadableThreadTranscript({
      threadRef,
      loadTranscript,
      writeClipboard,
      onSuccess,
      onError: vi.fn(),
    });

    expect(loadTranscript).toHaveBeenCalledTimes(2);
    expect(writeClipboard).toHaveBeenNthCalledWith(1, "# First", "readable chat transcript");
    expect(writeClipboard).toHaveBeenNthCalledWith(2, "# Second", "readable chat transcript");
    expect(onSuccess).toHaveBeenNthCalledWith(1, 2);
    expect(onSuccess).toHaveBeenNthCalledWith(2, 3);
  });

  it("reports load and clipboard failures without claiming success", async () => {
    const error = { _tag: "EnvironmentPayloadTooLargeError" };
    const onError = vi.fn();
    const onSuccess = vi.fn();

    const cancel = vi.fn();
    await copyReadableThreadTranscript({
      threadRef,
      loadTranscript: vi.fn().mockRejectedValue(error),
      beginClipboardWrite: vi.fn(() => ({ commit: vi.fn(), cancel })),
      writeClipboard: vi.fn(),
      onSuccess,
      onError,
    });

    expect(cancel).toHaveBeenCalledWith(error);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(error);
    expect(readableTranscriptCopyFailure(error)).toEqual({
      title: "Transcript too large",
      description: "This transcript is too large to copy.",
    });
  });
});
