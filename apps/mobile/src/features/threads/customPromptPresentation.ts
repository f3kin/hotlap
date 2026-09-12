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
