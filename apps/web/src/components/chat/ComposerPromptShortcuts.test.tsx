import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ComposerPromptShortcuts } from "./ComposerPromptShortcuts";

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
});

describe("ComposerPromptShortcuts", () => {
  it("prefills the selected saved prompt without submitting", async () => {
    const onSelect = vi.fn();
    const prompt = { id: "review", title: "Review", prompt: "Review these changes." };
    await act(() => {
      renderer = create(<ComposerPromptShortcuts prompts={[prompt]} onSelect={onSelect} />);
    });

    await act(() =>
      renderer!.root.findByProps({ "aria-label": "Use custom prompt: Review" }).props.onClick(),
    );
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(prompt);
  });

  it("has no shortcut surface for an empty library", async () => {
    await act(() => {
      renderer = create(<ComposerPromptShortcuts prompts={[]} onSelect={vi.fn()} />);
    });
    expect(renderer!.toJSON()).toBeNull();
  });
});
