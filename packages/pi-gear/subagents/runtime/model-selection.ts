import type { ModelSelection } from "./types.ts";

export function formatModelSelection(modelSelection: ModelSelection | undefined): string | undefined {
  const model = modelSelection?.model;
  if (!model) return undefined;

  const separator = model.indexOf("/");
  const provider = separator > 0 ? model.slice(0, separator) : undefined;
  const modelId = separator > 0 ? model.slice(separator + 1) : model;
  const identity = provider ? `(${provider}) ${modelId}` : modelId;
  return modelSelection.thinkingLevel ? `${identity} • ${modelSelection.thinkingLevel}` : identity;
}
