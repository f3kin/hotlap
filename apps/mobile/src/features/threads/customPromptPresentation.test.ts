import { describe, expect, it } from "vite-plus/test";

import {
  prefillComposerWithCustomPrompt,
  shouldShowCustomPromptControl,
} from "./customPromptPresentation";

describe("mobile custom prompt control", () => {
  it("prefills the draft and moves focus without submitting", () => {
    const composer = {
      draft: "",
      selection: { start: 0, end: 0 },
      focused: false,
      submissions: [] as string[],
    };

    prefillComposerWithCustomPrompt({
      prompt: "Review this change for correctness.",
      onChangeDraftMessage: (draft) => {
        composer.draft = draft;
      },
      editorRef: {
        current: {
          focus: () => {
            composer.focused = true;
          },
          setSelection: (selection) => {
            composer.selection = selection;
          },
        },
      },
      scheduleFocus: (focus) => focus(),
    });

    expect(composer).toEqual({
      draft: "Review this change for correctness.",
      selection: { start: 35, end: 35 },
      focused: true,
      submissions: [],
    });
  });

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
