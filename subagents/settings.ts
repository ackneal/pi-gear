import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { selectSubagentModel } from "./model-selector.ts";
import type { SubagentDispatch, ThinkingLevel } from "./runtime/types.ts";

export const SUBAGENT_SETTINGS_ENTRY = "pi-gear.subagent-settings";
export const SUBAGENT_MODEL_COMMAND = "gear:subagent-model";

const SUBAGENTS = ["researcher", "worker"] as const;
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

type SubagentId = typeof SUBAGENTS[number];
type ModelOverride = Required<SubagentDispatch>;
type SettingsState = Partial<Record<SubagentId, ModelOverride>>;

export interface SubagentSettings {
  resolve(id: SubagentId, ctx: ExtensionContext): SubagentDispatch;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}

function parseState(value: unknown): SettingsState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

  const state: SettingsState = {};
  for (const id of SUBAGENTS) {
    const candidate = (value as Record<string, unknown>)[id];
    if (candidate === undefined) continue;
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return undefined;

    const model = (candidate as Record<string, unknown>).model;
    const thinkingLevel = (candidate as Record<string, unknown>).thinkingLevel;
    if (typeof model !== "string" || !model.includes("/") || !isThinkingLevel(thinkingLevel)) return undefined;
    state[id] = { model, thinkingLevel };
  }
  return state;
}

function restoreState(ctx: ExtensionContext): SettingsState {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type === "custom" && entry.customType === SUBAGENT_SETTINGS_ENTRY) {
      return parseState(entry.data) ?? {};
    }
  }
  return {};
}

function modelChoices(ctx: ExtensionCommandContext) {
  return ctx.scopedModels.length > 0
    ? [...ctx.scopedModels]
    : ctx.modelRegistry.getAvailable().map((model) => ({ model }));
}

async function selectOption<T extends string>(
  ctx: ExtensionCommandContext,
  title: string,
  options: readonly T[],
): Promise<T | undefined> {
  return await ctx.ui.select(title, [...options]) as T | undefined;
}

async function selectSubagent(args: string, ctx: ExtensionCommandContext): Promise<SubagentId | undefined> {
  const requested = args.trim();
  if (SUBAGENTS.includes(requested as SubagentId)) return requested as SubagentId;

  const selected = await selectOption(ctx, "Configure subagent", SUBAGENTS);
  return SUBAGENTS.includes(selected as SubagentId) ? selected as SubagentId : undefined;
}

export function setupSubagentSettings(pi: ExtensionAPI): SubagentSettings {
  let state: SettingsState = {};
  const reconstruct = (ctx: ExtensionContext): void => { state = restoreState(ctx); };
  const persist = (): void => { pi.appendEntry(SUBAGENT_SETTINGS_ENTRY, structuredClone(state)); };

  pi.on("session_start", (_event, ctx) => reconstruct(ctx));
  pi.on("session_tree", (_event, ctx) => reconstruct(ctx));

  pi.registerCommand(SUBAGENT_MODEL_COMMAND, {
    description: "Set a subagent model and thinking level for this session",
    handler: async (args, ctx) => {
      const id = await selectSubagent(args, ctx);
      if (!id) return;

      const action = await selectOption(ctx, `${id} model`, ["Inherit from main", "Choose model"]);
      if (!action) return;
      if (action === "Inherit from main") {
        delete state[id];
        persist();
        ctx.ui.notify(`${id} now inherits the main model and thinking level`, "info");
        return;
      }

      const selected = await selectSubagentModel(
        ctx,
        `Select ${id} model`,
        modelChoices(ctx),
        state[id]?.thinkingLevel ?? ctx.thinkingLevel ?? "off",
      );
      if (!selected) return;

      state[id] = {
        model: `${selected.choice.model.provider}/${selected.choice.model.id}`,
        thinkingLevel: selected.thinkingLevel,
      };
      persist();
      ctx.ui.notify(`${id}: ${state[id].model} · ${selected.thinkingLevel}`, "info");
    },
  });

  return {
    resolve(id, ctx) {
      return state[id] ?? {
        ...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
        ...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
      };
    },
  };
}
