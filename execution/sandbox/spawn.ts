import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { commandEnvironment, commandShell } from "./environment.ts";

export interface SandboxProcessCallbacks {
  readonly isAvailable: () => boolean;
  readonly unavailableReason: () => string;
  readonly onCleanupFailure: () => void;
  readonly onExecutionPrevented: (command: string, reason: string) => void;
  readonly customConfigFor: () => Promise<SandboxRuntimeConfig>;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const executionDidNotRun = (
  callbacks: SandboxProcessCallbacks,
  command: string,
  reason: string,
): Error => {
  try {
    callbacks.onExecutionPrevented(command, reason);
  } catch {
    // Failure reporting must not change the no-execution result.
  }
  return new Error(
    `Sandboxed execution did not run: ${reason}. ` +
    `If they choose, instruct the user to manually run this exact command outside Pi: ${command}`,
  );
};

const killProcessGroup = (pid: number | undefined): boolean => {
  if (pid === undefined) {
    return false;
  }
  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch {
    // A group kill can race process exit; the child fallback covers platforms without process groups.
    return false;
  }
};

export function createSandboxedBashOperations(callbacks: SandboxProcessCallbacks): BashOperations {
  return {
    async exec(command, cwd, options) {
      if (!callbacks.isAvailable()) {
        throw executionDidNotRun(callbacks, command, `Sandbox unavailable: ${callbacks.unavailableReason()}`);
      }

      let wrappedCommand: string;
      const commandId = randomUUID();
      try {
        const customConfig = await callbacks.customConfigFor();
        wrappedCommand = await SandboxManager.wrapWithSandbox(command, "bash", customConfig, options.signal, {
          commandId,
          commandText: command,
        });
      } catch (error) {
        if (options.signal?.aborted) {
          throw new Error(`Sandbox aborted while wrapping: ${errorMessage(error)}`);
        }
        throw executionDidNotRun(callbacks, command, `Sandbox preparation failed: ${errorMessage(error)}`);
      }

      return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
        let settled = false;
        let timedOut = false;
        let aborted = options.signal?.aborted ?? false;
        let stderr = "";
        const child = spawn(commandShell(), ["-c", wrappedCommand], {
          cwd,
          detached: true,
          env: commandEnvironment(options.env),
          stdio: ["ignore", "pipe", "pipe"],
        });
        const abort = (): void => {
          aborted = true;
          if (!killProcessGroup(child.pid)) {
            child.kill("SIGKILL");
          }
        };
        const timeout = options.timeout;
        const timer = typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              abort();
            }, timeout * 1_000)
          : undefined;
        const finish = (result: { exitCode: number | null } | Error): void => {
          if (settled) {
            return;
          }
          settled = true;
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          options.signal?.removeEventListener("abort", abort);
          const annotation = SandboxManager.annotateStderrWithSandboxFailures(commandId, stderr);
          if (annotation !== stderr) options.onData(Buffer.from(`\nSandbox violation: ${annotation.slice(stderr.length)}\nNo unsandboxed fallback occurred; the user may manually run the original command outside Pi.\n`));
          try {
            SandboxManager.cleanupAfterCommand();
          } catch {
            // Command cleanup must not replace its process, timeout, or abort result.
            callbacks.onCleanupFailure();
          }
          if (result instanceof Error) {
            reject(result);
          } else {
            resolve(result);
          }
        };

        options.signal?.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", (data: Buffer) => options.onData(data));
        child.stderr.on("data", (data: Buffer) => { stderr += data; options.onData(data); });
        child.stdout.on("error", () => undefined);
        child.stderr.on("error", () => undefined);
        child.on("error", (error: Error) =>
          finish(new Error(`Sandbox process failed: ${error.message}`)),
        );
        child.on("close", (code: number | null) => {
          if (timedOut) {
            finish(new Error(`Sandbox timed out after ${timeout} seconds`));
          } else if (aborted) {
            finish(new Error("Sandbox aborted"));
          } else {
            finish({ exitCode: code });
          }
        });
        if (aborted) {
          abort();
        }
      });
    },
  };
}
