import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { pathToFileURL } from "node:url";
import type { LspServerConfig } from "../config/types.ts";
import { commandEnvironment } from "../execution/sandbox/environment.ts";
import { LspMessageDecoder, writeLspMessage, type JsonRpcMessage } from "./protocol.ts";
import { parsePublishDiagnostics } from "./schema.ts";
import type { LspDiagnostic, LspPosition } from "./types.ts";

export type SpawnLspProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { stdio: "pipe" },
) => ChildProcessWithoutNullStreams;

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

export class LspClient {
  private process: ChildProcessWithoutNullStreams | undefined;
  private startPromise: Promise<void> | undefined;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private versions = new Map<string, number>();
  private diagnostics = new Map<string, readonly LspDiagnostic[]>();
  private diagnosticsRevisions = new Map<string, number>();
  private stderr = "";
  private failure: Error | undefined;
  readonly config: LspServerConfig;
  private readonly cwd: string;
  private readonly spawnProcess: SpawnLspProcess;

  constructor(
    config: LspServerConfig,
    cwd: string,
    spawnProcess: SpawnLspProcess = (command, args, options) => spawn(command, args, options),
  ) {
    this.config = config;
    this.cwd = cwd;
    this.spawnProcess = spawnProcess;
  }

  get running(): boolean {
    return this.process !== undefined;
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.process) return;

    this.startPromise = this.initialize().catch((error) => {
      const child = this.process;
      this.process = undefined;
      this.startPromise = undefined;
      this.versions.clear();
      this.diagnostics.clear();
      this.diagnosticsRevisions.clear();
      if (child?.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      throw error;
    });
    return this.startPromise;
  }

  private async initialize(): Promise<void> {
    const [command, ...args] = this.config.command;
    if (!command) throw new Error("LSP command is empty");

    this.stderr = "";
    this.failure = undefined;
    const child = this.spawnProcess(command, args, {
      cwd: this.cwd,
      env: commandEnvironment(undefined),
      shell: false,
      stdio: "pipe",
    });
    this.process = child;
    const decoder = new LspMessageDecoder();

    child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const message of decoder.push(chunk)) this.receive(message);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-16_000);
    });
    child.once("error", (error) => this.fail(error));
    child.once("exit", (code) => {
      if (this.process !== child) return;
      this.process = undefined;
      this.startPromise = undefined;
      this.versions.clear();
      this.diagnostics.clear();
      this.diagnosticsRevisions.clear();
      this.fail(new Error(`Language server exited with code ${code ?? "unknown"}${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`));
    });

    await this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(this.cwd).href,
      workspaceFolders: [{ uri: pathToFileURL(this.cwd).href, name: this.cwd }],
      capabilities: { textDocument: { publishDiagnostics: { relatedInformation: false } } },
    });
    this.notify("initialized", {});
  }

  private receive(message: JsonRpcMessage): void {
    if (message.method === "textDocument/publishDiagnostics") {
      const params = parsePublishDiagnostics(message.params);
      this.diagnostics.set(params.uri, params.diagnostics);
      this.diagnosticsRevisions.set(params.uri, (this.diagnosticsRevisions.get(params.uri) ?? 0) + 1);
      return;
    }

    if (message.id === undefined) return;
    if (message.method) {
      if (this.process) {
        const result = message.method === "workspace/configuration" ? [] : null;
        writeLspMessage(this.process, { jsonrpc: "2.0", id: message.id, result });
      }
      return;
    }

    const pending = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
    if (!pending) return;
    if (typeof message.id === "number") this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }

  private fail(error: Error): void {
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  request(method: string, params: unknown): Promise<unknown> {
    const child = this.process;
    if (!child) return Promise.reject(new Error("Language server is not running"));
    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      writeLspMessage(child, { jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.process) throw new Error("Language server is not running");
    writeLspMessage(this.process, { jsonrpc: "2.0", method, params });
  }

  async sync(path: string): Promise<void> {
    await this.start();
    const text = await readFile(path, "utf8");
    const uri = pathToFileURL(path).href;
    const previous = this.versions.get(uri);
    const version = (previous ?? 0) + 1;
    this.versions.set(uri, version);

    if (previous === undefined) {
      const extension = extname(path);
      const languageId = this.config.languageIds[extension];
      if (!languageId) throw new Error(`No LSP languageId configured for ${extension || "this file"}`);
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version, text },
      });
    } else {
      this.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    }
  }

  diagnosticsFor(path: string): readonly LspDiagnostic[] {
    return this.diagnostics.get(pathToFileURL(path).href) ?? [];
  }

  async waitForDiagnostics(path: string, previousRevision: number, timeoutMs = 300): Promise<void> {
    const uri = pathToFileURL(path).href;
    const deadline = Date.now() + timeoutMs;
    while ((this.diagnosticsRevisions.get(uri) ?? 0) === previousRevision && Date.now() < deadline) {
      if (this.failure) throw this.failure;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (this.failure) throw this.failure;
  }

  diagnosticsRevision(path: string): number {
    return this.diagnosticsRevisions.get(pathToFileURL(path).href) ?? 0;
  }

  async navigate(method: "textDocument/definition" | "textDocument/references", path: string, position: LspPosition): Promise<unknown> {
    await this.sync(path);
    return this.request(method, method === "textDocument/references"
      ? { textDocument: { uri: pathToFileURL(path).href }, position, context: { includeDeclaration: true } }
      : { textDocument: { uri: pathToFileURL(path).href }, position });
  }

  async shutdown(): Promise<void> {
    const child = this.process;
    if (!child) return;

    try {
      await Promise.race([
        this.request("shutdown", null),
        new Promise((_, reject) => setTimeout(() => reject(new Error("LSP shutdown timed out")), 500)),
      ]);
      this.notify("exit", null);
    } catch {}

    this.process = undefined;
    this.startPromise = undefined;
    this.versions.clear();
    this.diagnostics.clear();
    this.diagnosticsRevisions.clear();
    this.fail(new Error("Language server shut down"));
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolve();
      }, 1_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
