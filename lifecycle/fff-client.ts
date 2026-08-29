import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";
import type { WatchEvent } from "@ff-labs/fff-node";
import type { FffEvent, FffMessage, FffMethod, FffParams, FffResponse } from "./fff-protocol.ts";

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

  request<M extends FffMethod>(method: M, params?: FffParams[M]): Promise<unknown> {
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

  close(): void { this.socket.destroy(); }

  #receive(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: FffMessage;
      try { message = JSON.parse(line) as FffMessage; }
      catch { this.emit("error", new Error("Invalid FFF sidecar JSON")); continue; }
      if ("event" in message) {
        const event = message as FffEvent;
        this.emit("watch", event.subscriptionId, event.data);
      } else {
        const response = message as FffResponse;
        const pending = this.#pending.get(response.id);
        if (!pending) continue;
        this.#pending.delete(response.id);
        if ("error" in response) pending.reject(new Error(response.error));
        else pending.resolve(response.result);
      }
    }
  }

  #fail(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
