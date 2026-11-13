import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ExtensionSelectorComponent, initTheme, type ExtensionToolContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { selectCommand } from "./selector.ts";

initTheme("dark", false);

type Select = ExtensionUIContext["select"];
const command = Array.from({ length: 80 }, (_, i) => `echo command_line_${i}`).join("\n");
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(t: TestContext, mode: "tui" | "rpc" = "tui") {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const dimensions = { columns: 120, rows: 60 };
  for (const key of ["columns", "rows"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, key);
    Object.defineProperty(process.stdout, key, { configurable: true, get: () => dimensions[key] });
    t.after(() => {
      if (descriptor) Object.defineProperty(process.stdout, key, descriptor);
      else Reflect.deleteProperty(process.stdout, key);
    });
  }

  const caller = new AbortController();
  const listeners = process.stdout.listenerCount("resize");
  let calls = 0;
  let active = 0;
  let select: Select = async () => "Run";
  const ui: Pick<ExtensionUIContext, "select"> = {
    async select(title, choices, options) {
      calls++;
      assert.equal(active, 0, "previous native selector must finish before reopening");
      assert.deepEqual(choices, ["Run", "Edit", "Cancel"]);
      assert.equal(process.stdout.listenerCount("resize"), listeners + (mode === "tui" ? 1 : 0));
      assert.ok(options?.signal);
      assert.equal(options.timeout, 31_000 - Date.now(), "timeout uses the original deadline");
      const height = new ExtensionSelectorComponent(
        title + ` (${Math.ceil(options.timeout! / 1000)}s)`, choices, () => {}, () => {},
      ).render(dimensions.columns).length;
      if (mode === "tui") assert.ok(height <= Math.floor(dimensions.rows / 2), `${height} native rows exceed half-height`);
      active++;
      try { return await select(title, choices, options); }
      finally { active--; }
    },
  };
  // Only mode and ui.select are used by this helper; all UI calls retain SDK types.
  const ctx = { mode, ui } as ExtensionToolContext;
  const run = () => selectCommand(ctx, command, "Review command", "/tmp", caller.signal);
  t.after(() => assert.equal(process.stdout.listenerCount("resize"), listeners));
  return {
    caller, dimensions, run,
    setSelect(value: Select) { select = value; },
    get calls() { return calls; },
    resize() { process.stdout.emit("resize"); },
  };
}

type Fixture = ReturnType<typeof fixture>;
const cases: { name: string; mode?: "rpc"; run: (f: Fixture, t: TestContext) => Promise<void> }[] = [
  ...(["Run", "Edit", "Cancel", undefined] as const).map((choice) => ({
    name: `native ${choice ?? "escape/timeout"} returns without reopening`,
    async run(f: Fixture) {
      f.setSelect(async () => choice);
      assert.equal(await f.run(), choice);
      assert.equal(f.calls, 1);
    },
  })),
  {
    name: "repeated resizes recalculate native half-screen layout and remaining timeout",
    async run(f, t) {
      const titles: string[] = [];
      f.setSelect(async (title, _choices, options) => {
        titles.push(title);
        if (f.calls === 3) return "Edit";
        const aborted = new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => resolve(), { once: true }));
        f.dimensions.columns -= 30;
        f.dimensions.rows -= 16;
        const staleHeight = new ExtensionSelectorComponent(
          title + " (30s)", ["Run", "Edit", "Cancel"], () => {}, () => {},
        ).render(f.dimensions.columns).length;
        assert.ok(staleHeight > Math.floor(f.dimensions.rows / 2), "the old title no longer fits after shrinking");
        t.mock.timers.tick(4000);
        f.resize();
        await aborted;
        assert.ok(options!.signal!.reason, "resize uses an explicit abort reason");
        return undefined;
      });
      assert.equal(await f.run(), "Edit");
      assert.equal(f.calls, 3);
      assert.equal(new Set(titles).size, 3, "each shrink produces a fresh title");
    },
  },
  {
    name: "awaits prior completion and drops stale Run racing with resize",
    async run(f) {
      let finish!: (choice: string) => void;
      f.setSelect(async () => f.calls === 1 ? new Promise<string>((resolve) => { finish = resolve; }) : "Cancel");
      const result = f.run();
      f.resize();
      f.resize();
      await turn();
      assert.equal(f.calls, 1, "abort alone does not release native UI ownership");
      finish("Run");
      assert.equal(await result, "Cancel");
      assert.equal(f.calls, 2);
    },
  },
  {
    name: "stale Edit racing with resize also cannot escape",
    async run(f) {
      f.setSelect(async () => {
        if (f.calls === 1) { f.resize(); return "Edit"; }
        return undefined;
      });
      assert.equal(await f.run(), undefined);
      assert.equal(f.calls, 2);
    },
  },
  {
    name: "initial caller abort never opens a selector",
    async run(f) {
      f.caller.abort();
      assert.equal(await f.run(), undefined);
      assert.equal(f.calls, 0);
    },
  },
  {
    name: "caller or session abort during resize prevents reopening and overrides Run",
    async run(f) {
      f.setSelect(async (_title, _choices, options) => {
        f.resize();
        f.caller.abort();
        assert.ok(options!.signal!.aborted);
        return "Run";
      });
      assert.equal(await f.run(), undefined);
      assert.equal(f.calls, 1);
    },
  },
  {
    name: "caller abort overrides a regular native Run",
    async run(f) {
      f.setSelect(async () => { f.caller.abort(); return "Run"; });
      assert.equal(await f.run(), undefined);
      assert.equal(f.calls, 1);
    },
  },
  ...[false, true].map((resize) => ({
    name: `deadline overrides Run${resize ? " and resize" : ""}`,
    async run(f: Fixture, t: TestContext) {
      f.setSelect(async () => {
        t.mock.timers.tick(30_000);
        if (resize) f.resize();
        return "Run";
      });
      assert.equal(await f.run(), undefined);
      assert.equal(f.calls, 1);
    },
  })),
  {
    name: "deadline reached during formatting never opens a selector with timeout zero",
    async run(f, t) {
      const render = ExtensionSelectorComponent.prototype.render;
      t.mock.method(ExtensionSelectorComponent.prototype, "render", function (this: ExtensionSelectorComponent, width: number) {
        t.mock.timers.tick(30_000);
        return render.call(this, width);
      });
      assert.equal(await f.run(), undefined);
      assert.equal(f.calls, 0);
    },
  },
  {
    name: "native rejection propagates and removes the resize listener",
    async run(f) {
      const error = new Error("native selector failed");
      f.setSelect(async () => { throw error; });
      await assert.rejects(f.run(), (caught) => caught === error);
      assert.equal(f.calls, 1);
    },
  },
  {
    name: "RPC uses one native call with the caller signal and no resize listener",
    mode: "rpc",
    async run(f) {
      f.setSelect(async (title, _choices, options) => {
        assert.equal(title, `Run command?\n\nReview command\n\n/tmp\n$ ${command}`);
        assert.equal(options!.signal, f.caller.signal);
        f.resize();
        return "Run";
      });
      assert.equal(await f.run(), "Run");
      assert.equal(f.calls, 1);
    },
  },
];

test("selectCommand preserves native selection across resize", async (t) => {
  for (const row of cases) await t.test(row.name, async (t) => {
    const f = fixture(t, row.mode);
    await row.run(f, t);
  });
});
