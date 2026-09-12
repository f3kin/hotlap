import { describe, expect, it } from "vite-plus/test";

import { moveCustomPrompt, removeCustomPrompt, saveCustomPrompt } from "./customPrompts.ts";

describe("custom prompt library edits", () => {
  const first = { id: "first", title: "First", prompt: "First prompt" };
  const second = { id: "second", title: "Second", prompt: "Second prompt" };

  it("trims and appends new entries while preserving duplicate content", () => {
    const result = saveCustomPrompt([], {
      id: "one",
      title: "  Review  ",
      prompt: "  Review this change.  ",
    });
    expect(result).toEqual({
      ok: true,
      prompts: [{ id: "one", title: "Review", prompt: "Review this change." }],
    });
    if (!result.ok) return;
    expect(
      saveCustomPrompt(result.prompts, {
        id: "two",
        title: "Review",
        prompt: "Review this change.",
      }),
    ).toMatchObject({ ok: true, prompts: [{ id: "one" }, { id: "two" }] });
  });

  it("replaces an existing stable id in place", () => {
    expect(
      saveCustomPrompt([first, second], {
        id: "first",
        title: "Updated",
        prompt: "Updated prompt",
      }),
    ).toEqual({
      ok: true,
      prompts: [{ id: "first", title: "Updated", prompt: "Updated prompt" }, second],
    });
  });

  it("returns actionable validation failures", () => {
    expect(saveCustomPrompt([], { id: "id", title: " ", prompt: "Prompt" })).toEqual({
      ok: false,
      message: "Enter a title.",
    });
    expect(saveCustomPrompt([], { id: "id", title: "Title", prompt: " " })).toEqual({
      ok: false,
      message: "Enter a prompt.",
    });
    expect(
      saveCustomPrompt([], { id: "id", title: "x".repeat(61), prompt: "Prompt" }),
    ).toMatchObject({ ok: false });
    expect(
      saveCustomPrompt([], { id: "id", title: "Title", prompt: "x".repeat(10_001) }),
    ).toMatchObject({ ok: false });
    expect(
      saveCustomPrompt(
        Array.from({ length: 20 }, (_, index) => ({
          id: String(index),
          title: String(index),
          prompt: "Prompt",
        })),
        { id: "new", title: "New", prompt: "Prompt" },
      ),
    ).toMatchObject({ ok: false });
    expect(
      saveCustomPrompt(
        Array.from({ length: 6 }, (_, index) => ({
          id: String(index),
          title: String(index),
          prompt: "😀".repeat(2_400),
        })),
        { id: "new", title: "New", prompt: "😀".repeat(2_400) },
      ),
    ).toMatchObject({ ok: false });
  });

  it("moves and removes entries without mutating input", () => {
    const source = [first, second];
    expect(moveCustomPrompt(source, "second", -1)).toEqual([second, first]);
    expect(moveCustomPrompt(source, "first", -1)).toEqual(source);
    expect(removeCustomPrompt(source, "first")).toEqual([second]);
    expect(source).toEqual([first, second]);
  });
});
