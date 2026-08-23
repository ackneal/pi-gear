import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { selectSubagentModel } from "./model-selector.ts";
import {
  RuntimeConfigStore,
  type RuntimeSubagentId,
  type RuntimeSubagentSetting,
} from "./runtime-config.ts";
import type { SubagentDispatch } from "./runtime/types.ts";

export const SUBAGENTS = ["researcher", "worker"] as const;

export type SubagentId = RuntimeSubagentId;

export interface SubagentSummary {
  id: SubagentId;
  mode: "inherit" | "override";
  source: "main" | "runtime";
  dispatch: SubagentDispatch;
  available: boolean;
}

export interface RuntimeSettingsStore {
  load(): Promise<void>;
  error(): string | undefined;
  get(id: SubagentId): RuntimeSubagentSetting | undefined;
  set(id: SubagentId, setting: RuntimeSubagentSetting): Promise<void>;
}

export interface SubagentSettings {
  resolve(id: SubagentId, ctx: ExtensionContext): SubagentDispatch;
  summaries(ctx: ExtensionContext): SubagentSummary[];
  runtimeError(): string | undefined;
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

function mainDispatch(ctx: ExtensionContext): SubagentDispatch {
  return {
    ...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
    ...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
  };
}

function dispatchFor(setting: RuntimeSubagentSetting | undefined, ctx: ExtensionContext): SubagentDispatch {
  return setting?.mode === "override"
    ? { model: `${setting.provider}/${setting.model}`, thinkingLevel: setting.thinkingLevel }
    : mainDispatch(ctx);
}

export function setupSubagentSettings(
  pi: ExtensionAPI,
  runtime: RuntimeSettingsStore = new RuntimeConfigStore(),
): SubagentSettings {
  pi.on("session_start", async () => runtime.load());

  const resolve = (id: SubagentId, ctx: ExtensionContext): SubagentDispatch =>
    dispatchFor(runtime.get(id), ctx);

  return {
    resolve,
    summaries(ctx) {
      const availableModels = ctx.modelRegistry.getAvailable();

      return SUBAGENTS.map((id) => {
        const setting = runtime.get(id);

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
    runtimeError: () => runtime.error(),
    async configure(args, ctx) {
      const id = await selectSubagent(args, ctx);
      if (!id) return;

      const action = await selectOption(ctx, `${id} model`, ["Inherit from main", "Choose model"]);
      if (!action) return;

      try {
        let setting: RuntimeSubagentSetting = { mode: "inherit" };
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

        await runtime.set(id, setting);
        ctx.ui.notify(`${id} ${setting.mode} saved as the default`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  };
}
