import type { CustomPrompt } from "@t3tools/contracts/settings";

import { Button } from "../ui/button";

export function ComposerPromptShortcuts(props: {
  readonly prompts: readonly CustomPrompt[];
  readonly onSelect: (prompt: CustomPrompt) => void;
}) {
  if (props.prompts.length === 0) return null;

  return (
    <div
      aria-label="Custom prompts"
      className="pointer-events-none absolute inset-x-2 bottom-full z-20 mb-2 flex max-h-28 flex-wrap justify-end gap-1.5 overflow-y-auto opacity-0 transition-opacity group-focus-within/composer-stack:pointer-events-auto group-focus-within/composer-stack:opacity-100 group-hover/composer-stack:pointer-events-auto group-hover/composer-stack:opacity-100"
    >
      {props.prompts.map((prompt) => (
        <Button
          key={prompt.id}
          size="xs"
          variant="glass"
          aria-label={`Use custom prompt: ${prompt.title}`}
          onClick={() => props.onSelect(prompt)}
        >
          {prompt.title}
        </Button>
      ))}
    </div>
  );
}
