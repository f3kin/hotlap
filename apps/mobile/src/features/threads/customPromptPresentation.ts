interface CustomPromptEditor {
  readonly focus: () => void;
  readonly setSelection: (selection: { readonly start: number; readonly end: number }) => void;
}

export function prefillComposerWithCustomPrompt(input: {
  readonly prompt: string;
  readonly onChangeDraftMessage: (draft: string) => void;
  readonly editorRef: { readonly current: CustomPromptEditor | null };
  readonly scheduleFocus?: (focus: () => void) => void;
}): void {
  input.onChangeDraftMessage(input.prompt);
  const focusEditor = () => {
    input.editorRef.current?.focus();
    input.editorRef.current?.setSelection({ start: input.prompt.length, end: input.prompt.length });
  };
  (input.scheduleFocus ?? requestAnimationFrame)(focusEditor);
}

export function shouldShowCustomPromptControl(input: {
  readonly supported: boolean;
  readonly promptCount: number;
  readonly draftMessage: string;
  readonly editorReadOnly: boolean;
}): boolean {
  return (
    input.supported &&
    input.promptCount > 0 &&
    input.draftMessage.trim().length === 0 &&
    !input.editorReadOnly
  );
}
