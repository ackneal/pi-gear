import { rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import type { FileFinderApi, FileItem, InitOptions, Result, WatchUnsubscribe } from "@ff-labs/fff-bun";
import {
  DEFAULT_INDEX_READY_TIMEOUT_MS, FFF_SOCKET_ENV, isFffRequest,
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
  const finderOptions = fffFinderOptions(options.basePath);
  const finder: FileFinderApi = options.createFinder
    ? unwrap(options.createFinder(finderOptions))
    : unwrap((await import("@ff-labs/fff-bun")).FileFinder.create(finderOptions));
  const subscriptionsBySocket = new Map<Socket, Map<number, WatchUnsubscribe>>();
  const sockets = new Set<Socket>();
  let nextSubscriptionId = 1;
  let closing = false;

  await rm(options.socketPath, { force: true });
  const server = createServer((socket) => {
    const subscriptions = new Map<number, WatchUnsubscribe>();
    subscriptionsBySocket.set(socket, subscriptions);
    sockets.add(socket);
    socket.once("close", () => {
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptionsBySocket.delete(socket);
      sockets.delete(socket);
    });
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

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          socket.destroy();
          return;
        }
        if (!isFffRequest(parsed)) {
          socket.destroy();
          return;
        }
        void handle(socket, parsed);
      }
    });
    socket.on("error", () => undefined);
  });

  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    for (const subscriptions of subscriptionsBySocket.values()) {
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
    }
    subscriptionsBySocket.clear();
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
      if (request.method !== "status" && request.method !== "shutdown" && request.method !== "subscribe" && request.method !== "unsubscribe") {
        const ready = unwrap(await finder.waitForIndexReady(options.readyTimeoutMs ?? DEFAULT_INDEX_READY_TIMEOUT_MS));
        if (!ready) throw new Error("FFF index is still building; retry shortly");
      }
      let result: unknown;
      switch (request.method) {
        case "status":
          result = {
            progress: unwrap(finder.getScanProgress()),
            health: unwrap(finder.healthCheck()),
          };
          break;
        case "fileSearch":
          result = unwrap(finder.fileSearch(request.params.query, request.params.options));
          break;
        case "glob":
          result = unwrap(finder.glob(request.params.pattern, request.params.options));
          break;
        case "mixedSearch":
          result = unwrap(finder.mixedSearch(request.params.query, request.params.options));
          break;
        case "grep":
          result = unwrap(finder.grep(request.params.query, request.params.options));
          break;
        case "multiGrep":
          result = unwrap(finder.multiGrep(request.params));
          break;
        case "files":
          result = await inventory(request.params?.pageSize);
          break;
        case "dirtyFiles":
          unwrap(finder.refreshGitStatus());
          result = (await inventory(request.params?.pageSize)).filter((file) =>
            file.gitStatus !== "clean" &&
            file.gitStatus !== "ignored" &&
            file.gitStatus !== ""
          );
          break;
        case "trackQuery":
          result = unwrap(finder.trackQuery(request.params.query, request.params.selectedFilePath));
          break;
        case "subscribe": {
          const subscriptionId = nextSubscriptionId++;
          const callback = (data: unknown): void => { socket.write(`${JSON.stringify({ event: "watch", subscriptionId, data })}\n`); };
          const params = request.params ?? {};
          const watched = params.pattern === undefined
            ? finder.watch(callback, params.options)
            : finder.watch(params.pattern, callback, params.options);
          subscriptionsBySocket.get(socket)?.set(subscriptionId, unwrap(watched));
          result = { subscriptionId };
          break;
        }
        case "unsubscribe": {
          const subscriptions = subscriptionsBySocket.get(socket);
          subscriptions?.get(request.params.subscriptionId)?.();
          subscriptions?.delete(request.params.subscriptionId);
          result = true;
          break;
        }
        case "shutdown":
          result = true;
          break;
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
