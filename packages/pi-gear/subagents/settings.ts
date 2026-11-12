import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { selectSubagentModel } from "./model-selector.ts";
import {
  FileModelSettingsStore,
  type SubagentId,
  type SubagentModelSetting,
} from "./model-settings.ts";
import type { ModelSelection } from "./runtime/types.ts";

export const SUBAGENTS = ["researcher", "worker", "reviewer"] as const;

export interface SubagentSummary {
  id: SubagentId;
  mode: "inherit" | "override";
  source: "main" | "runtime";
  dispatch: ModelSelection;
  available: boolean;
}

export interface ModelSettingsStore {
  load(): Promise<void>;
  error(): string | undefined;
  get(id: SubagentId): SubagentModelSetting | undefined;
  set(id: SubagentId, setting: SubagentModelSetting): Promise<void>;
}

export interface SubagentSettings {
  resolve(id: SubagentId, ctx: ExtensionContext): ModelSelection;
  summaries(ctx: ExtensionContext): SubagentSummary[];
  settingsError(): string | undefined;
  configure(args: string, ctx: ExtensionCommandContext): Promise<void>;
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

function mainDispatch(ctx: ExtensionContext): ModelSelection {
  return {
    ...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
    ...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
  };
}

function dispatchFor(setting: SubagentModelSetting | undefined, ctx: ExtensionContext): ModelSelection {
  return setting?.mode === "override"
    ? { model: `${setting.provider}/${setting.model}`, thinkingLevel: setting.thinkingLevel }
    : mainDispatch(ctx);
}

export function setupSubagentSettings(
  pi: ExtensionAPI,
  settingsStore: ModelSettingsStore = new FileModelSettingsStore(),
): SubagentSettings {
  pi.on("session_start", async () => settingsStore.load());

  const resolve = (id: SubagentId, ctx: ExtensionContext): ModelSelection =>
    dispatchFor(settingsStore.get(id), ctx);

  return {
    resolve,
    summaries(ctx) {
      const availableModels = ctx.modelRegistry.getAvailable();

      return SUBAGENTS.map((id) => {
        const setting = settingsStore.get(id);

        return {
          id,
          mode: setting?.mode ?? "inherit",
          source: setting ? "runtime" : "main",
          dispatch: dispatchFor(setting, ctx),
          available: setting?.mode === "override"
            ? availableModels.some((model) => model.provider === setting.provider && model.id === setting.model)
            : ctx.model !== undefined,
        };
      });
    },
    settingsError: () => settingsStore.error(),
    async configure(args, ctx) {
      const id = await selectSubagent(args, ctx);
      if (!id) return;

      const action = await selectOption(ctx, `${id} model`, ["Inherit from main", "Choose model"]);
      if (!action) return;

      try {
        let setting: SubagentModelSetting = { mode: "inherit" };
        if (action === "Choose model") {
          const selected = await selectSubagentModel(
            ctx,
            `Select ${id} model`,
            modelChoices(ctx),
            resolve(id, ctx).thinkingLevel ?? "off",
          );
          if (!selected) return;
          setting = {
            mode: "override",
            provider: selected.choice.model.provider,
            model: selected.choice.model.id,
            thinkingLevel: selected.thinkingLevel,
          };
        }

        await settingsStore.set(id, setting);
        ctx.ui.notify(`${id} ${setting.mode} saved as the default`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  };
}
