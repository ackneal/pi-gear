import type { ChildProcess } from "node:child_process";
import { KILL_TIMEOUT_MS, appendBounded, spawnPiChild, type SpawnProcess } from "./process.ts";
import { MAX_STDERR_CHARS } from "./limits.ts";
import { PiJsonDecoder } from "./protocol.ts";
import { reduceSubagentEvent } from "./state.ts";
import type { RunSubagentOptions, SubagentRun } from "./types.ts";

type KillTimer = ReturnType<typeof setTimeout> | number;

export interface RunChildSubagentOptions extends RunSubagentOptions {
  childExtension: URL;
  cwd?: string;
  spawnProcess?: SpawnProcess;
  spawnChild?: () => ChildProcess;
  setKillTimer?: (callback: () => void, milliseconds: number) => KillTimer;
  clearKillTimer?: (timer: KillTimer) => void;
}

const snapshot = (run: SubagentRun): SubagentRun => ({
  ...run,
  items: run.items.map((item) => ({ ...item })),
});

export async function runChildSubagent(options: RunChildSubagentOptions): Promise<SubagentRun> {
  const startedAt = Date.now();
  let run: SubagentRun = { status: "running", startedAt, lastActivityAt: startedAt, items: [] };
  let child: ChildProcess;
  let terminal = false;
  let aborted = false;
  let killTimer: KillTimer | undefined;
  let stderr = "";
  const decoder = new PiJsonDecoder();

  const update = (): void => {
    if (!terminal) options.onUpdate(snapshot(run));
  };

  const consume = (chunk: Buffer, final = false): void => {
    if (terminal) return;

    for (const event of decoder.push(chunk, final)) {
      if (terminal) return;
      run = reduceSubagentEvent(run, event);
      if (event.type !== "diagnostic") update();
    }
  };

  try {
    child = options.spawnChild
      ? options.spawnChild()
      : spawnPiChild(options.profile, options.task, options.childExtension, options.spawnProcess, options.cwd);
  } catch (error) {
    const now = Date.now();
    return {
      ...run,
      status: "error",
      finishedAt: now,
      lastActivityAt: now,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const onStdout = (chunk: Buffer): void => consume(chunk);
  const onStderr = (chunk: Buffer): void => {
    if (!terminal) stderr = appendBounded(stderr, chunk.toString(), MAX_STDERR_CHARS);
  };
  const setKillTimer = options.setKillTimer ?? setTimeout;
  const clearKillTimer = options.clearKillTimer ?? clearTimeout;
  const onAbort = (): void => {
    if (terminal || aborted) return;
    aborted = true;
    child.kill("SIGTERM");
    killTimer = setKillTimer(() => {
      if (!terminal) child.kill("SIGKILL");
    }, KILL_TIMEOUT_MS);
  };

  child.stdout?.on("data", onStdout);
  child.stderr?.on("data", onStderr);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  return await new Promise((resolve) => {
    const cleanup = (): void => {
      if (killTimer !== undefined) clearKillTimer(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
    };

    const finish = (status: SubagentRun["status"], error?: string): void => {
      if (terminal) return;
      terminal = true;
      cleanup();
      const now = Date.now();
      run = {
        ...run,
        status,
        finishedAt: now,
        lastActivityAt: now,
        ...(error ? { error } : {}),
      };
      options.onUpdate(snapshot(run));
      resolve(snapshot(run));
    };

    const onError = (error: Error): void => finish("error", error.message);
    const onClose = (code: number | null): void => {
      if (terminal) return;
      consume(Buffer.alloc(0), true);

      if (aborted) {
        finish("aborted");
      } else if (code !== 0) {
        finish("error", `Subagent exited with code ${code ?? "unknown"}.${stderr.trim() ? ` ${stderr.trim()}` : ""}`);
      } else if (!run.result?.trim()) {
        finish("error", "Subagent exited successfully without a final report.");
      } else {
        finish("success");
      }
    };

    child.once("error", onError);
    child.once("close", onClose);
  });
}
