import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { FffClient } from "./fff-client.ts";
import { FFF_SOCKET_ENV } from "./fff-protocol.ts";

export const resolveFffRoot = (basePath: string): Promise<string> => realpath(basePath);

export interface FffSidecarOptions {
  startupTimeoutMs?: number;
  nodePath?: string;
}

/** Session-owned FFF process and its private Unix socket. */
export class FffSidecar {
  readonly basePath: string;
  readonly socketPath: string;
  readonly client: FffClient;
  readonly child: ChildProcess;
  readonly #tempDir: string;
  #closed = false;

  private constructor(basePath: string, tempDir: string, socketPath: string, child: ChildProcess, client: FffClient) {
    this.basePath = basePath;
    this.#tempDir = tempDir;
    this.socketPath = socketPath;
    this.child = child;
    this.client = client;
  }

  static async start(basePath: string, options: FffSidecarOptions = {}): Promise<FffSidecar> {
    const fffRoot = await resolveFffRoot(basePath);
    const tempDir = await mkdtemp(join(tmpdir(), "pi-gear-fff-"));
    await chmod(tempDir, 0o700);
    const socketPath = join(tempDir, "fff.sock");
    await rm(socketPath, { force: true });
    const daemonPath = fileURLToPath(new URL("./fff-sidecar.ts", import.meta.url));
    const child = spawn(options.nodePath ?? process.execPath, [
      "--experimental-strip-types", daemonPath, fffRoot, String(process.pid),
    ], {
      env: { ...process.env, [FFF_SOCKET_ENV]: socketPath },
      stdio: "ignore",
    });

    const deadline = Date.now() + (options.startupTimeoutMs ?? 5_000);
    try {
      for (;;) {
        if (child.exitCode !== null) throw new Error(`FFF sidecar exited with code ${child.exitCode}`);
        try {
          const client = await FffClient.connect(socketPath);
          return new FffSidecar(basePath, tempDir, socketPath, child, client);
        } catch (error) {
          if (Date.now() >= deadline) throw new Error(`FFF sidecar did not open its socket: ${error instanceof Error ? error.message : error}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
    } catch (error) {
      child.kill();
      await rm(tempDir, { recursive: true, force: true });
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await Promise.race([
        this.client.request("shutdown"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown timed out")), 1_000)),
      ]);
    } catch {
      this.child.kill();
    } finally {
      this.client.close();
      if (this.child.exitCode === null) this.child.kill();
      await rm(this.#tempDir, { recursive: true, force: true });
    }
  }

  async [Symbol.asyncDispose](): Promise<void> { await this.dispose(); }
}
