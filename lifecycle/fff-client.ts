import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";
import type { WatchEvent } from "@ff-labs/fff-bun";
import { isFffMessage, type FffMethod, type FffParams } from "./fff-protocol.ts";

export interface FffClientEvents {
  watch: [subscriptionId: number, events: WatchEvent[]];
  close: [];
  error: [error: Error];
}

export class FffClient extends EventEmitter<FffClientEvents> {
  readonly socket: Socket;
  #nextId = 1;
  #buffer = "";
  #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  constructor(socket: Socket) {
    super();
    // EventEmitter throws reserved "error" events without a listener.
    this.on("error", () => undefined);
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.#receive(String(chunk)));
    socket.on("error", (error) => { this.emit("error", error); this.#fail(error); });
    socket.on("close", () => { this.#fail(new Error("FFF connection closed")); this.emit("close"); });
  }

  static connect(socketPath: string): Promise<FffClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      const fail = (error: Error): void => reject(error);
      socket.once("error", fail);
      socket.once("connect", () => {
        socket.off("error", fail);
        resolve(new FffClient(socket));
      });
    });
  }

  request<M extends FffMethod>(
    method: M,
    ...[params]: undefined extends FffParams[M] ? [params?: FffParams[M]] : [params: FffParams[M]]
  ): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.socket.write(`${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`, (error) => {
        if (error) { this.#pending.delete(id); reject(error); }
      });
    });
  }

  async subscribe(listener: (events: WatchEvent[]) => void, pattern?: string): Promise<() => Promise<void>> {
    const result = await this.request("subscribe", pattern === undefined ? {} : { pattern }) as { subscriptionId: number };
    const handler = (id: number, events: WatchEvent[]): void => { if (id === result.subscriptionId) listener(events); };
    this.on("watch", handler);
    return async () => {
      this.off("watch", handler);
      await this.request("unsubscribe", { subscriptionId: result.subscriptionId });
    };
  }

  close(error?: Error): void { this.socket.destroy(error); }

  #receive(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.#rejectProtocol("Invalid FFF sidecar JSON");
        return;
      }
      if (!isFffMessage(parsed)) {
        this.#rejectProtocol("Invalid FFF sidecar message");
        return;
      }
      const message = parsed;
      if ("event" in message) {
        this.emit("watch", message.subscriptionId, message.data);
      } else {
        const pending = this.#pending.get(message.id);
        if (!pending) continue;
        this.#pending.delete(message.id);
        if ("error" in message) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
      }
    }
  }

  #rejectProtocol(message: string): void {
    const error = new Error(message);
    this.emit("error", error);
    this.#fail(error);
    this.socket.destroy();
  }

  #fail(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
