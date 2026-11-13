import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  initTheme,
  type ExtensionAPI,
  type ExtensionToolContext,
  type ExtensionUIContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, type Component } from "@earendil-works/pi-tui";
import { ConfirmationQueue } from "./confirmation-queue.ts";
import { setupRequestCommand, type CommandDetails, type requestCommandParameters } from "./request-command.ts";

initTheme();

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for external editor lifecycle.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("cancelled external editor retains approval ownership until the native TUI restarts", { timeout: 20_000 }, async (t) => {
  for (const action of ["abort", "session_start"] as const) await t.test(action, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-command-editor-"));
    const script = join(directory, "editor.cjs");
    const marker = join(directory, "started");
    const release = join(directory, "release");
    const visual = process.env.VISUAL;
    const events: string[] = [];
    let externalStopped = false;
    t.after(async () => {
      await writeFile(release, "exit");
      await waitFor(() => !externalStopped);
      if (visual === undefined) delete process.env.VISUAL;
      else process.env.VISUAL = visual;
      await rm(directory, { recursive: true, force: true });
    });
    await writeFile(script, `
const fs = require('node:fs');
const [marker, release, prompt] = process.argv.slice(2);
fs.writeFileSync(marker, 'started');
const timer = setInterval(() => {
  if (!fs.existsSync(release)) return;
  clearInterval(timer);
  fs.writeFileSync(prompt, "printf late-editor-result");
}, 10);
setTimeout(() => process.exit(2), 7000).unref();
`);
    process.env.VISUAL = `${process.execPath} ${script} ${marker} ${release}`;

    let tool!: ToolDefinition<typeof requestCommandParameters, CommandDetails>;
    const handlers: Record<string, () => void> = {};
    const executed: string[] = [];
    setupRequestCommand({
      on: (event: string, handler: () => void) => { handlers[event] = handler; },
      registerTool: (registered: typeof tool) => { tool = registered; },
    } as unknown as ExtensionAPI, {
      confirmationQueue: new ConfirmationQueue(),
      createBashTool: (() => ({
        execute: async (_id: string, input: { command: string }) => {
          executed.push(input.command);
          return { content: [], details: undefined };
        },
      })) as never,
    });
    const custom: ExtensionUIContext["custom"] = async <T>(factory: Parameters<ExtensionUIContext["custom"]>[0]): Promise<T> => new Promise((resolve, reject) => {
      let component: (Component & { dispose?(): void }) | undefined;
      const done = (value: unknown) => {
        events.push("done");
        component?.dispose?.();
        resolve(value as T);
      };
      Promise.resolve(factory(
        {
          stop() { externalStopped = true; events.push("stop"); },
          start() { externalStopped = false; events.push("start"); },
          requestRender() {},
        } as unknown as Parameters<typeof factory>[0],
        {} as Parameters<typeof factory>[1],
        new KeybindingsManager({
          "app.editor.external": { defaultKeys: "ctrl+g", description: "External editor" },
        }) as unknown as Parameters<typeof factory>[2],
        done,
      )).then((created) => {
        component = created;
        component.handleInput?.("\u0007");
      }).catch(reject);
    });
    let selections = 0;
    const ctx = {
      cwd: process.cwd(), hasUI: true, mode: "tui",
      ui: {
        custom,
        select: async () => {
          if (++selections === 1) return "Edit";
          assert.equal(externalStopped, false, "next approval cannot take the stopped terminal");
          events.push("next-select");
          return "Run";
        },
      },
    } as unknown as ExtensionToolContext;
    const controller = new AbortController();
    const first = tool.execute("first", { command: "printf original" }, controller.signal, undefined, ctx);
    await waitFor(async () => {
      try { return await readFile(marker, "utf8") === "started"; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    });
    if (action === "abort") controller.abort();
    else handlers.session_start!();
    const result = await first;
    assert.equal(result.details?.status, "Cancelled");
    assert.equal(externalStopped, true, "cancelled request returns before the external editor exits");
    const second = tool.execute("second", { command: "printf next" }, undefined, undefined, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(selections, 1);
    assert.deepEqual(executed, []);
    await writeFile(release, "exit");
    const next = await second;
    assert.equal(next.details?.status, "Completed");
    await waitFor(() => !externalStopped && events.includes("done"));
    assert.ok(events.indexOf("start") < events.indexOf("done"));
    assert.ok(events.indexOf("done") < events.indexOf("next-select"));
    assert.deepEqual(executed, ["printf next"]);
  });
});
