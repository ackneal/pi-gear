import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { resolve } from "node:path";
import { Type } from "typebox";
import {
  openSubagentDetailOverlay,
  recordSubagentLiveStart,
  recordSubagentLiveUpdate,
} from "../ui/subagent/detail/index.ts";
import { renderSubagentCall, renderSubagentResult } from "../ui/subagent/renderer.ts";
import {
  formatResearcherInput,
  RESEARCHER_TOOL_NAME,
  researcherParameters,
  researcherProfile,
  runResearcher,
} from "./agents/researcher/index.ts";
import {
  formatWorkerInput,
  WORKER_TOOL_NAME,
  workerParameters,
  workerProfile,
  runWorker,
} from "./agents/worker/index.ts";
import { BackgroundRunRegistry, type BackgroundSnapshot } from "./runtime/background.ts";
import { setupSubagentRuntimeLifecycle } from "./runtime/lifecycle.ts";
import { subagentControlResult, type CompactSubagentOutput } from "./runtime/output.ts";
import { setupSubagentSettleGuard } from "./runtime/settle-guard.ts";
import type { SubagentRun } from "./runtime/types.ts";
import { setupSubagentSettings, type SubagentSettings } from "./settings.ts";

export interface SubagentServices {
  settings: SubagentSettings;
  inspect(ctx: ExtensionContext, toolCallId?: string): Promise<void>;
}

function backgroundResult(snapshot: BackgroundSnapshot): AgentToolResult<SubagentRun> {
  const details = Object.assign(snapshot.run, { runId: snapshot.runId, revision: snapshot.revision });
  return {
    content: [{ type: "text", text: JSON.stringify({ runId: snapshot.runId, status: snapshot.status, revision: snapshot.revision }) }],
    details,
  };
}

function recordUpdate(toolCallId: string | undefined, run: SubagentRun): void {
  if (toolCallId) recordSubagentLiveUpdate(toolCallId, run);
}

// Control tools (subagent_observe/subagent_cancel) carry no transcript UI.
const hidden = (): Component => ({ render: () => [], invalidate: () => {} });

export function setupSubagents(pi: ExtensionAPI): SubagentServices {
  const settings = setupSubagentSettings(pi);
  const background = new BackgroundRunRegistry();

  setupSubagentRuntimeLifecycle(pi, background);
  setupSubagentSettleGuard(pi, () => background.listUnresolved());

  pi.registerTool({
    name: RESEARCHER_TOOL_NAME,
    label: researcherProfile.label,
    description: "Start focused read-only research. Returns immediately with a runId; use subagent_observe for progress or completion.",
    parameters: researcherParameters,
    executionMode: "parallel",
    async execute(toolCallId, { question, scope }, signal, _onUpdate, ctx): Promise<AgentToolResult<SubagentRun>> {
      const task = formatResearcherInput({ question, scope });
      const dispatch = settings.resolve("researcher", ctx);
      if (toolCallId) recordSubagentLiveStart(toolCallId, researcherProfile, task);

      return backgroundResult(background.start({
        profile: researcherProfile, task, dispatch, ...(signal ? { parentSignal: signal } : {}),
        run: (childSignal, update) => runResearcher(task, { cwd: ctx.cwd, dispatch, signal: childSignal, onUpdate: (next) => { if (update(next)) recordUpdate(toolCallId, next); } }),
      }));
    },
    renderCall: renderSubagentCall,
    renderResult: (toolResult: AgentToolResult<any>, options, theme, context) =>
      renderSubagentResult(researcherProfile, toolResult as AgentToolResult<SubagentRun>, options, theme, context as any),
    renderShell: "self",
  });

  pi.registerTool({
    name: WORKER_TOOL_NAME,
    label: workerProfile.label,
    description: "Start one bounded task. Returns immediately with a runId; use subagent_observe for progress or completion. Set targetFiles when files may be modified so active scope conflicts can be rejected.",
    parameters: workerParameters,
    executionMode: "parallel",
    async execute(toolCallId, { task: requestedTask, targetFiles, findings, verification }, signal, _onUpdate, ctx): Promise<AgentToolResult<SubagentRun>> {
      const task = formatWorkerInput({ task: requestedTask, targetFiles, findings, verification });
      const dispatch = settings.resolve("worker", ctx);
      if (toolCallId) recordSubagentLiveStart(toolCallId, workerProfile, task);

      return backgroundResult(background.start({
        profile: workerProfile, task, dispatch, ...(targetFiles?.length ? { writerScopes: targetFiles.map((file) => resolve(ctx.cwd, file)) } : {}), ...(signal ? { parentSignal: signal } : {}),
        run: (childSignal, update) => runWorker(task, { cwd: ctx.cwd, dispatch, signal: childSignal, onUpdate: (next) => { if (update(next)) recordUpdate(toolCallId, next); } }),
      }));
    },
    renderCall: renderSubagentCall,
    renderResult: (toolResult: AgentToolResult<any>, options, theme, context) =>
      renderSubagentResult(workerProfile, toolResult as AgentToolResult<SubagentRun>, options, theme, context as any),
    renderShell: "self",
  });

  pi.registerTool({
    name: "subagent_observe",
    label: "Observe subagent",
    description: "Wait for meaningful subagent progress, completion, or a bounded timeout. A timeout ends only this observation; the subagent keeps running.",
    parameters: Type.Object({
      runId: Type.String({ description: "Run identifier returned by researcher or worker." }),
      afterRevision: Type.Integer({ minimum: 0, description: "Last observed revision. Returns when a newer revision is available." }),
      timeoutSeconds: Type.Optional(Type.Number({ minimum: 0, description: "Maximum seconds to wait. Defaults to 30; values above 60 are clamped." })),
    }),
    async execute(_toolCallId, { runId, afterRevision, timeoutSeconds }): Promise<AgentToolResult<CompactSubagentOutput>> {
      const waited = await background.wait(runId, afterRevision, timeoutSeconds);
      return subagentControlResult(waited.snapshot, waited.reason);
    },
    renderCall: hidden,
    renderResult: hidden,
    renderShell: "self",
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel subagent",
    description: "Cancel one subagent and wait for its process to terminate. Other runs and the main agent continue; repeated cancellation returns the same terminal state.",
    parameters: Type.Object({ runId: Type.String({ description: "Run identifier returned by researcher or worker." }) }),
    async execute(_toolCallId, { runId }): Promise<AgentToolResult<CompactSubagentOutput>> {
      return subagentControlResult(await background.cancel(runId));
    },
    renderCall: hidden,
    renderResult: hidden,
    renderShell: "self",
  });

  return { settings, inspect: (ctx, toolCallId) => openSubagentDetailOverlay(ctx, toolCallId) };
}
