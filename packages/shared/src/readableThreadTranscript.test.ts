import {
  ComposerContextId,
  MessageId,
  TurnId,
  type OrchestrationMessage,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ReadableTranscriptMessageNotFoundError,
  buildForkProviderInput,
  serializeReadableThreadTranscript,
} from "./readableThreadTranscript.ts";

const message = (
  input: Partial<OrchestrationMessage> & Pick<OrchestrationMessage, "id" | "role" | "text">,
): OrchestrationMessage => ({
  turnId: TurnId.make("turn-1"),
  streaming: false,
  createdAt: "2026-09-12T00:00:00.000Z",
  updatedAt: "2026-09-12T00:00:00.000Z",
  ...input,
});

describe("buildForkProviderInput", () => {
  it("keeps the newest whole history sections and marks omitted older history", () => {
    const input = buildForkProviderInput({
      messages: [
        {
          sourceMessageId: MessageId.make("one"),
          role: "user",
          text: `Old question ${"x".repeat(100)}`,
          createdAt: "x",
        },
        {
          sourceMessageId: MessageId.make("two"),
          role: "assistant",
          text: "Old answer",
          createdAt: "x",
        },
        {
          sourceMessageId: MessageId.make("three"),
          role: "assistant",
          text: "Selected answer",
          createdAt: "x",
        },
      ],
      continuation: "Continue here",
      maxChars: 270,
    });

    expect(input).not.toBeNull();
    if (input === null) return;
    expect(input).toContain("[Older inherited messages omitted to fit the provider context.]\n\n");
    expect(input).toContain("## Assistant\n\nSelected answer");
    expect(input).not.toContain("Old question");
    expect(input.endsWith("## New user message\n\nContinue here")).toBe(true);
  });

  it("returns null when the selected response and continuation cannot both fit", () => {
    expect(
      buildForkProviderInput({
        messages: [
          {
            sourceMessageId: MessageId.make("selected"),
            role: "assistant",
            text: "x".repeat(100),
            createdAt: "x",
          },
        ],
        continuation: "continue",
        maxChars: 80,
      }),
    ).toBeNull();
  });
});

describe("serializeReadableThreadTranscript", () => {
  it("serializes only readable chat roles and expands citations and context labels", () => {
    const contextId = ComposerContextId.make("file-1");
    const result = serializeReadableThreadTranscript([
      message({ id: MessageId.make("system"), role: "system", text: "hidden setup" }),
      message({
        id: MessageId.make("user"),
        role: "user",
        text: "Review [config](t3-context://v1/file/file-1)",
        attachments: [
          {
            type: "file",
            id: "attachment-1",
            name: "settings.json",
            mimeType: "application/json",
            sizeBytes: 42,
          },
        ],
        context: {
          version: 1,
          records: [
            {
              version: 1,
              contextId,
              kind: "file",
              label: "config",
              attachmentId: "attachment-1",
              name: "settings.json",
              mimeType: "application/json",
              sizeBytes: 42,
            },
          ],
        },
      }),
      message({
        id: MessageId.make("assistant"),
        role: "assistant",
        text: "Done",
      }),
    ]);

    expect(result).toEqual({
      markdown:
        "## User\n\nReview [File: config]\n\nAttachments: settings.json\n\n## Assistant\n\nDone",
      messageCount: 2,
    });
  });

  it("marks a streaming assistant response and preserves an attachment-only user message", () => {
    const result = serializeReadableThreadTranscript([
      message({
        id: MessageId.make("user"),
        role: "user",
        text: "",
        attachments: [
          {
            type: "image",
            id: "image-1",
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 42,
          },
        ],
      }),
      message({
        id: MessageId.make("assistant"),
        role: "assistant",
        text: "Working on it",
        streaming: true,
      }),
    ]);

    expect(result.markdown).toBe(
      "## User\n\nAttachments: screen.png\n\n## Assistant\n\nWorking on it\n\n_(response in progress)_",
    );
    expect(result.messageCount).toBe(2);
  });

  it("does not repeat an attachment name already represented by an inline context label", () => {
    const contextId = ComposerContextId.make("file-inline");
    const result = serializeReadableThreadTranscript([
      message({
        id: MessageId.make("user-inline-file"),
        role: "user",
        text: "Review [settings.json](t3-context://v1/file/file-inline)",
        attachments: [
          {
            type: "file",
            id: "attachment-inline",
            name: "settings.json",
            mimeType: "application/json",
            sizeBytes: 42,
          },
        ],
        context: {
          version: 1,
          records: [
            {
              version: 1,
              contextId,
              kind: "file",
              label: "settings.json",
              attachmentId: "attachment-inline",
              name: "settings.json",
              mimeType: "application/json",
              sizeBytes: 42,
            },
          ],
        },
      }),
    ]);

    expect(result.markdown).toBe("## User\n\nReview [File: settings.json]");
  });

  it("stops inclusively at the selected response", () => {
    const throughMessageId = MessageId.make("assistant-1");
    const result = serializeReadableThreadTranscript(
      [
        message({ id: MessageId.make("user-1"), role: "user", text: "First" }),
        message({ id: throughMessageId, role: "assistant", text: "Answer" }),
        message({ id: MessageId.make("user-2"), role: "user", text: "Later" }),
      ],
      { throughMessageId },
    );

    expect(result.markdown).toBe("## User\n\nFirst\n\n## Assistant\n\nAnswer");
    expect(result.messageCount).toBe(2);
  });

  it("rejects an unknown inclusive endpoint instead of silently returning a partial transcript", () => {
    expect(() =>
      serializeReadableThreadTranscript(
        [message({ id: MessageId.make("user"), role: "user", text: "Hello" })],
        { throughMessageId: MessageId.make("missing") },
      ),
    ).toThrow(ReadableTranscriptMessageNotFoundError);
  });
});
