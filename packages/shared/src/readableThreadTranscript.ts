import type { ComposerContextKind, MessageId } from "@t3tools/contracts";

import { assistantCitationsToPlainText } from "./assistantCitations.ts";
import {
  collectComposerContextReferences,
  replaceComposerContextReferences,
} from "./composerContextReferences.ts";

export class ReadableTranscriptMessageNotFoundError extends Error {
  override readonly name = "ReadableTranscriptMessageNotFoundError";
  readonly messageId: MessageId;

  constructor(messageId: MessageId) {
    super("The requested transcript endpoint does not exist in this thread.");
    this.messageId = messageId;
  }
}

export interface ReadableThreadTranscript {
  readonly markdown: string;
  readonly messageCount: number;
}

export interface ReadableThreadMessageSource {
  readonly id: MessageId;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly streaming: boolean;
  readonly createdAt: string;
  readonly attachments?: ReadonlyArray<{ readonly name: string }> | undefined;
  readonly context?:
    | {
        readonly records: ReadonlyArray<{
          readonly contextId: string;
          readonly kind: ComposerContextKind;
          readonly label: string;
        }>;
      }
    | undefined;
}

export interface ReadableThreadMessage {
  readonly sourceMessageId: MessageId;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

function displayKind(kind: ComposerContextKind): string {
  const words = kind.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function readableLabel(kind: ComposerContextKind, label: string): string {
  return `[${displayKind(kind)}: ${label.replace(/\s+/g, " ").trim()}]`;
}

function readableText(message: ReadableThreadMessageSource): {
  readonly text: string;
  readonly referencedContextIds: ReadonlySet<string>;
  readonly representedAttachmentNames: ReadonlySet<string>;
} {
  const withCitations = assistantCitationsToPlainText(message.text);
  const references = collectComposerContextReferences(withCitations);
  return {
    text: replaceComposerContextReferences(withCitations, ({ kind, label }) =>
      readableLabel(kind, label),
    ),
    referencedContextIds: new Set(references.map(({ contextId }) => contextId)),
    representedAttachmentNames: new Set(
      references
        .filter(({ kind }) => kind === "file" || kind === "image")
        .map(({ label }) => label.replace(/\s+/g, " ").trim().toLowerCase()),
    ),
  };
}

function projectMessage(message: ReadableThreadMessageSource): ReadableThreadMessage | null {
  if (message.role === "system") return null;

  const readable = readableText(message);
  const parts: string[] = [];
  if (readable.text.trim().length > 0) parts.push(readable.text.trim());

  const attachmentNames = message.attachments
    ?.map(({ name }) => name.replace(/\s+/g, " ").trim())
    .filter(
      (name) => name.length > 0 && !readable.representedAttachmentNames.has(name.toLowerCase()),
    );
  if (attachmentNames && attachmentNames.length > 0) {
    parts.push(`Attachments: ${attachmentNames.join(", ")}`);
  }

  const contextLabels = message.context?.records
    .filter(
      (record) =>
        !readable.referencedContextIds.has(record.contextId) &&
        record.kind !== "file" &&
        record.kind !== "image",
    )
    .map((record) => readableLabel(record.kind, record.label));
  if (contextLabels && contextLabels.length > 0) {
    parts.push(`Context: ${contextLabels.join(", ")}`);
  }

  if (message.role === "assistant" && message.streaming) {
    parts.push("_(response in progress)_");
  }
  if (parts.length === 0) return null;
  return {
    sourceMessageId: message.id,
    role: message.role,
    text: parts.join("\n\n"),
    createdAt: message.createdAt,
  };
}

export function projectReadableThreadMessages(
  messages: ReadonlyArray<ReadableThreadMessageSource>,
  options: { readonly throughMessageId?: MessageId } = {},
): ReadonlyArray<ReadableThreadMessage> {
  let included = messages;
  if (options.throughMessageId !== undefined) {
    const endpointIndex = messages.findIndex(({ id }) => id === options.throughMessageId);
    if (endpointIndex < 0) {
      throw new ReadableTranscriptMessageNotFoundError(options.throughMessageId);
    }
    included = messages.slice(0, endpointIndex + 1);
  }
  return included.flatMap((message) => {
    const projected = projectMessage(message);
    return projected === null ? [] : [projected];
  });
}

export function serializeReadableThreadTranscript(
  messages: ReadonlyArray<ReadableThreadMessageSource>,
  options: { readonly throughMessageId?: MessageId } = {},
): ReadableThreadTranscript {
  const readableMessages = projectReadableThreadMessages(messages, options);
  const sections = readableMessages.map(
    (message) => `## ${message.role === "user" ? "User" : "Assistant"}\n\n${message.text}`,
  );
  return { markdown: sections.join("\n\n"), messageCount: sections.length };
}

export function buildForkProviderInput(input: {
  readonly messages: ReadonlyArray<ReadableThreadMessage>;
  readonly continuation: string;
  readonly maxChars: number;
}): { readonly text: string; readonly omittedMessageCount: number } | null {
  const intro =
    "This conversation was forked. Continue from the inherited transcript below using the newest workspace state.\n\n";
  const continuation = `\n\n## New user message\n\n${input.continuation}`;
  const omission = "[Older inherited messages omitted to fit the provider context.]\n\n";
  const groups: Array<{ readonly sections: string[]; readonly messageCount: number }> = [];
  for (const message of input.messages) {
    const section = `## ${message.role === "user" ? "User" : "Assistant"}\n\n${message.text}`;
    const previous = groups.at(-1);
    if (message.role === "user" || previous === undefined) {
      groups.push({ sections: [section], messageCount: 1 });
    } else {
      groups[groups.length - 1] = {
        sections: [...previous.sections, section],
        messageCount: previous.messageCount + 1,
      };
    }
  }
  if (groups.length === 0) return null;

  const groupTexts = groups.map((group) => group.sections.join("\n\n"));
  const suffixLengths = Array.from({ length: groups.length }, () => 0);
  let suffixLength = 0;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    suffixLength += groupTexts[index]!.length + (index === groups.length - 1 ? 0 : 2);
    suffixLengths[index] = suffixLength;
  }

  let omittedMessageCount = 0;
  for (let start = 0; start < groups.length; start += 1) {
    const omittedPrefix = start === 0 ? "" : omission;
    const resultLength =
      intro.length + omittedPrefix.length + suffixLengths[start]! + continuation.length;
    if (resultLength <= input.maxChars) {
      return {
        text: `${intro}${omittedPrefix}${groupTexts.slice(start).join("\n\n")}${continuation}`,
        omittedMessageCount,
      };
    }
    omittedMessageCount += groups[start]!.messageCount;
  }
  return null;
}
