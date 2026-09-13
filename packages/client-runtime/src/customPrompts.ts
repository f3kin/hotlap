import {
  CUSTOM_PROMPT_BODY_MAX_CHARS,
  CUSTOM_PROMPT_TITLE_MAX_CHARS,
  CUSTOM_PROMPTS_MAX_BYTES,
  CUSTOM_PROMPTS_MAX_COUNT,
  type CustomPrompt,
} from "@t3tools/contracts/settings";

export type CustomPromptSaveResult =
  | { readonly ok: true; readonly prompts: readonly CustomPrompt[] }
  | { readonly ok: false; readonly message: string };

const textEncoder = new TextEncoder();

export function saveCustomPrompt(
  prompts: readonly CustomPrompt[],
  input: CustomPrompt,
): CustomPromptSaveResult {
  const id = input.id.trim();
  const title = input.title.trim();
  const prompt = input.prompt.trim();
  if (!id) return { ok: false, message: "This prompt needs an id." };
  if (!title) return { ok: false, message: "Enter a title." };
  if (!prompt) return { ok: false, message: "Enter a prompt." };
  if (title.length > CUSTOM_PROMPT_TITLE_MAX_CHARS) {
    return {
      ok: false,
      message: `Titles can be at most ${String(CUSTOM_PROMPT_TITLE_MAX_CHARS)} characters.`,
    };
  }
  if (prompt.length > CUSTOM_PROMPT_BODY_MAX_CHARS) {
    return {
      ok: false,
      message: `Prompts can be at most ${String(CUSTOM_PROMPT_BODY_MAX_CHARS)} characters.`,
    };
  }

  const existingIndex = prompts.findIndex((entry) => entry.id === id);
  if (existingIndex < 0 && prompts.length >= CUSTOM_PROMPTS_MAX_COUNT) {
    return {
      ok: false,
      message: `You can save up to ${String(CUSTOM_PROMPTS_MAX_COUNT)} prompts.`,
    };
  }
  if (
    existingIndex >= 0 &&
    prompts.some((entry, index) => index !== existingIndex && entry.id === id)
  ) {
    return { ok: false, message: "This prompt id is already in use." };
  }

  const entry = { id, title, prompt };
  const next = [...prompts];
  if (existingIndex >= 0) next[existingIndex] = entry;
  else next.push(entry);
  if (textEncoder.encode(JSON.stringify(next)).byteLength > CUSTOM_PROMPTS_MAX_BYTES) {
    return {
      ok: false,
      message: "Your saved prompts are too large. Shorten one before saving.",
    };
  }
  return { ok: true, prompts: next };
}

export function moveCustomPrompt(
  prompts: readonly CustomPrompt[],
  id: string,
  offset: -1 | 1,
): readonly CustomPrompt[] {
  const from = prompts.findIndex((entry) => entry.id === id);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= prompts.length) return prompts;
  const next = [...prompts];
  const [entry] = next.splice(from, 1);
  if (!entry) return prompts;
  next.splice(to, 0, entry);
  return next;
}

export function removeCustomPrompt(
  prompts: readonly CustomPrompt[],
  id: string,
): readonly CustomPrompt[] {
  return prompts.filter((entry) => entry.id !== id);
}
