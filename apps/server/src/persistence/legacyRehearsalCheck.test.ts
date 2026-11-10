import { describe, expect, it } from "@effect/vitest";
import { compareHistory, type HistoryMessage } from "./legacyRehearsalCheck.ts";

const message = (id: string): HistoryMessage => ({
  id,
  role: "user",
  text: "preserve me",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  attachments: [{ id: "attachment", sizeBytes: 5 }],
  context: { nested: { value: "context" } },
});

describe("legacy rehearsal history comparison", () => {
  it("accepts equivalent JSON object key order", () => {
    const first = message("one");
    expect(
      compareHistory([first], [{ ...first, attachments: [{ sizeBytes: 5, id: "attachment" }] }])
        .equal,
    ).toBe(true);
  });
  it("rejects a missing message even when the remaining tail is identical", () => {
    expect(compareHistory([message("one"), message("two")], [message("two")]).missing).toBe(1);
  });
  it("rejects duplicated visible messages", () => {
    expect(compareHistory([message("one")], [message("one"), message("one")]).equal).toBe(false);
  });
  it.each(["text", "createdAt", "updatedAt", "role", "attachments", "context"] as const)(
    "rejects altered %s",
    (field) => {
      const first = message("one");
      expect(compareHistory([first], [{ ...first, [field]: "changed" }]).equal).toBe(false);
    },
  );
  it("rejects changed conversation ordering", () => {
    expect(
      compareHistory([message("one"), message("two")], [message("two"), message("one")])
        .orderChanged,
    ).toBe(true);
  });
});
