import type { ModelSelection } from "./types.ts";

export function formatModelSelection(dispatch: ModelSelection | undefined): string | undefined {
  const model = dispatch?.model;
  if (!model) return undefined;

  const separator = model.indexOf("/");
  const provider = separator > 0 ? model.slice(0, separator) : undefined;
  const modelId = separator > 0 ? model.slice(separator + 1) : model;
  const identity = provider ? `(${provider}) ${modelId}` : modelId;
  return dispatch.thinkingLevel ? `${identity} • ${dispatch.thinkingLevel}` : identity;
}
