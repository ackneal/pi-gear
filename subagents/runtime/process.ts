import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { bridgeToolName, type CapabilitySpec } from "../../capabilities/index.ts";
import type { SubagentDispatch, SubagentProfile } from "./types.ts";

export const MAX_OUTPUT_CHARS = 32_000;
export const KILL_TIMEOUT_MS = 1_000;
export type SpawnProcess = typeof spawn;

export function appendBounded(current: string, value: string, max = MAX_OUTPUT_CHARS): string {
  const joined = `${current}${value}`;
  return joined.length > max ? `[truncated]\n${joined.slice(-(max - 12))}` : joined;
}

/** Resolve the installed Pi package entrypoint, keeping the child on this extension's pinned runtime. */
export interface PiRuntime { argv: readonly string[]; execPath: string; exists: (path: string) => boolean; }
export function resolvePiInvocation(runtime: PiRuntime = { argv: process.argv, execPath: process.execPath, exists: existsSync }): { command: string; prefixArgs: string[] } {
  const currentScript = runtime.argv[1];
  const bunVirtualScript = currentScript?.startsWith("/$bunfs/root/") ?? false;
  if (currentScript && !bunVirtualScript && runtime.exists(currentScript)) return { command: runtime.execPath, prefixArgs: [currentScript] };
  const executable = basename(runtime.execPath).toLowerCase();
  if (executable === "node" || executable === "node.exe" || executable === "bun" || executable === "bun.exe") return { command: "pi", prefixArgs: [] };
  return { command: runtime.execPath, prefixArgs: [] };
}

export function capabilityToolNames(capabilities: readonly CapabilitySpec[]): string[] {
  return capabilities.flatMap((capability) => capability.kind === "builtin" ? [capability.name] : capability.tools.map((tool) => bridgeToolName(capability.id, tool.name)));
}

export function childArgs(profile: SubagentProfile, task: string, childExtension: URL, dispatch?: SubagentDispatch): string[] {
  return [
    "--mode",
    "json",
    "--no-session",
    ...(dispatch?.model ? ["--model", dispatch.model] : []),
    ...(dispatch?.thinkingLevel ? ["--thinking", dispatch.thinkingLevel] : []),
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--extension",
    fileURLToPath(childExtension),
    "--tools",
    capabilityToolNames(profile.capabilities).join(","),
    "--append-system-prompt",
    profile.systemPrompt,
    task,
  ];
}

export function spawnPiChild(
  profile: SubagentProfile,
  task: string,
  childExtension: URL,
  spawnProcess: SpawnProcess = spawn,
  cwd: string = process.cwd(),
  dispatch?: SubagentDispatch,
): ChildProcess {
  const invocation = resolvePiInvocation();
  return spawnProcess(invocation.command, [...invocation.prefixArgs, ...childArgs(profile, task, childExtension, dispatch)], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
