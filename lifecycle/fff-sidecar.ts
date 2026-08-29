import { rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { FileFinder } from "@ff-labs/fff-node";
import type { FileFinderApi, FileItem, InitOptions, MultiGrepOptions, Result, WatchUnsubscribe } from "@ff-labs/fff-node";
import {
  DEFAULT_INDEX_READY_TIMEOUT_MS, FFF_SOCKET_ENV,
  type FffRequest,
} from "./fff-protocol.ts";

export function fffFinderOptions(basePath: string): InitOptions {
  return {
    basePath,
    disableContentIndexing: false,
    disableMmapCache: false,
    disableWatch: false,
    aiMode: true,
    followSymlinks: false,
    enableFsRootScanning: false,
    enableHomeDirScanning: false,
  };
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

export interface FffSidecarServerOptions {
  socketPath: string;
  basePath: string;
  parentPid?: number;
  readyTimeoutMs?: number;
  createFinder?: (options: InitOptions) => Result<FileFinderApi>;
}

export async function startFffSidecar(options: FffSidecarServerOptions): Promise<{ server: Server; close(): Promise<void> }> {
  const created = (options.createFinder ?? ((value) => FileFinder.create(value)))(fffFinderOptions(options.basePath));
  const finder = unwrap(created);
  const subscriptions = new Map<number, WatchUnsubscribe>();
  const sockets = new Set<Socket>();
  let nextSubscriptionId = 1;
  let closing = false;

  await rm(options.socketPath, { force: true });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        void handle(socket, JSON.parse(line) as FffRequest);
      }
    });
    socket.on("error", () => undefined);
  });

  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    subscriptions.clear();
    finder.destroy();
    for (const socket of sockets) socket.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(options.socketPath, { force: true });
  };

  async function inventory(pageSize = 10_000): Promise<FileItem[]> {
    const items: FileItem[] = [];
    for (let pageIndex = 0;; pageIndex++) {
      const page = unwrap(finder.glob("**/*", { pageIndex, pageSize }));
      items.push(...page.items);
      if (items.length >= page.totalMatched || page.items.length === 0) return items;
    }
  }

  async function handle(socket: Socket, request: FffRequest): Promise<void> {
    try {
      const params = (request.params ?? {}) as Record<string, any>;
      if (request.method !== "status" && request.method !== "shutdown" && request.method !== "subscribe" && request.method !== "unsubscribe") {
        const ready = unwrap(await finder.waitForIndexReady(options.readyTimeoutMs ?? DEFAULT_INDEX_READY_TIMEOUT_MS));
        if (!ready) throw new Error("FFF index is still building; retry shortly");
      }
      let result: unknown;
      switch (request.method) {
        case "status": result = { progress: unwrap(finder.getScanProgress()), health: unwrap(finder.healthCheck()) }; break;
        case "fileSearch": result = unwrap(finder.fileSearch(params.query, params.options)); break;
        case "glob": result = unwrap(finder.glob(params.pattern, params.options)); break;
        case "mixedSearch": result = unwrap(finder.mixedSearch(params.query, params.options)); break;
        case "grep": result = unwrap(finder.grep(params.query, params.options)); break;
        case "multiGrep": result = unwrap(finder.multiGrep(params as MultiGrepOptions)); break;
        case "files": result = await inventory(params.pageSize); break;
        case "dirtyFiles":
          unwrap(finder.refreshGitStatus());
          result = (await inventory(params.pageSize)).filter((file) => file.gitStatus !== "clean" && file.gitStatus !== "ignored" && file.gitStatus !== "");
          break;
        case "trackQuery": result = unwrap(finder.trackQuery(params.query, params.selectedFilePath)); break;
        case "subscribe": {
          const subscriptionId = nextSubscriptionId++;
          const callback = (data: unknown): void => { socket.write(`${JSON.stringify({ event: "watch", subscriptionId, data })}\n`); };
          const watched = params.pattern === undefined
            ? finder.watch(callback, params.options)
            : finder.watch(params.pattern, callback, params.options);
          subscriptions.set(subscriptionId, unwrap(watched));
          result = { subscriptionId };
          break;
        }
        case "unsubscribe": subscriptions.get(params.subscriptionId)?.(); subscriptions.delete(params.subscriptionId); result = true; break;
        case "shutdown": result = true; break;
      }
      socket.write(`${JSON.stringify({ id: request.id, result })}\n`, () => {
        if (request.method === "shutdown") void close();
      });
    } catch (error) {
      socket.write(`${JSON.stringify({ id: request.id, error: error instanceof Error ? error.message : String(error) })}\n`);
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => { server.off("error", reject); resolve(); });
  });

  let orphanTimer: NodeJS.Timeout | undefined;
  if (options.parentPid) {
    orphanTimer = setInterval(() => {
      try { process.kill(options.parentPid!, 0); }
      catch { void close(); }
    }, 1_000);
    orphanTimer.unref();
    server.once("close", () => clearInterval(orphanTimer));
  }
  return { server, close };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const socketPath = process.env[FFF_SOCKET_ENV];
  const basePath = process.argv[2];
  const parentPid = Number(process.argv[3]);
  if (!socketPath || !basePath) throw new Error("FFF sidecar requires a socket and base path");
  await startFffSidecar({ socketPath, basePath, ...(Number.isInteger(parentPid) ? { parentPid } : {}) });
}
