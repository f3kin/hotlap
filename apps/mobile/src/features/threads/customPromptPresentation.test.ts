import { describe, expect, it } from "vite-plus/test";

import { shouldShowCustomPromptControl } from "./customPromptPresentation";

describe("mobile custom prompt control", () => {
  it("is offered for an editable empty composer when the cached server capability is present", () => {
    expect(
      shouldShowCustomPromptControl({
        supported: true,
        promptCount: 1,
        draftMessage: "  ",
        editorReadOnly: false,
      }),
    ).toBe(true);
  });

  it.each([
    { supported: false, promptCount: 1, draftMessage: "", editorReadOnly: false },
    { supported: true, promptCount: 0, draftMessage: "", editorReadOnly: false },
    { supported: true, promptCount: 1, draftMessage: "Typed", editorReadOnly: false },
    { supported: true, promptCount: 1, draftMessage: "", editorReadOnly: true },
  ])("hides for unsupported, empty-library, nonempty, or read-only states", (input) => {
    expect(shouldShowCustomPromptControl(input)).toBe(false);
  });
});
