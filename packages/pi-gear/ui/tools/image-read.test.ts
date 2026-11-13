import { configureOutputPadding } from "./padding.ts";
configureOutputPadding({ getSettings: () => ({ outputPad: 0 }) });
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { getCustomToolDefinition } from "./index.ts";

initTheme();
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;

function makeContext<T extends Record<string, unknown>>(
  args: T,
  overrides: Partial<{
    cwd: string;
    expanded: boolean;
    isError: boolean;
    isPartial: boolean;
    executionStarted: boolean;
    lastComponent: Component;
    state: Record<string, unknown>;
    showImages: boolean;
    invalidate: () => void;
  }> = {},
) {
  return {
    args,
    cwd: overrides.cwd ?? "/workspace",
    expanded: overrides.expanded ?? false,
    isError: overrides.isError ?? false,
    lastComponent: overrides.lastComponent,
    state: overrides.state ?? {},
    executionStarted: overrides.executionStarted ?? true,
    invalidate: overrides.invalidate ?? (() => undefined),
    argsComplete: true,
    isPartial: overrides.isPartial ?? false,
    showImages: overrides.showImages ?? true,
    toolCallId: "image-read-test",
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function renderedLines(component: { render(width: number): string[] }, width = 200): string[] {
  return component.render(width).map(stripAnsi);
}

function makePngBase64(width: number, height: number): string {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(buf);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf.toString("base64");
}

function makeJpegBase64(width: number, height: number): string {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00,
  ]).toString("base64");
}

function makeGifBase64(width: number, height: number): string {
  const buf = Buffer.alloc(10);
  buf.write("GIF89a", 0, "ascii");
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf.toString("base64");
}

function makeWebpBase64(width: number, height: number): string {
  const buf = Buffer.alloc(30);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(22, 4);
  buf.write("WEBP", 8, "ascii");
  buf.write("VP8X", 12, "ascii");
  buf.writeUInt32LE(10, 16);
  buf.writeUIntLE(width - 1, 24, 3);
  buf.writeUIntLE(height - 1, 27, 3);
  return buf.toString("base64");
}

test("image read renderCall displays basename, expanded resolved path, and wraps without ellipsis", () => {
  const read = getCustomToolDefinition("read", "/workspace")!;
  const longFilename = `${"screenshot_part_".repeat(6)}final.png`;

  const cases = [
    {
      name: "relative path collapsed",
      args: { path: "assets/images/photo.png" },
      expanded: false,
      width: 120,
      expectedLines: ["● Read(photo.png)"],
    },
    {
      name: "relative path with dot-dot segments expanded",
      args: { path: "assets/../nested/./photo.jpg" },
      expanded: true,
      width: 120,
      expectedLines: ["● Read(photo.jpg)", "  Path: /workspace/nested/photo.jpg"],
    },
    {
      name: "home tilde path expanded via file_path alias",
      args: { file_path: "~/Pictures/vacation.webp" },
      expanded: true,
      width: 200,
      expectedLines: ["● Read(vacation.webp)", `  Path: ${resolve(homedir(), "Pictures/vacation.webp")}`],
    },
    {
      name: "filepath alias collapsed",
      args: { filepath: "/tmp/assets/banner.gif" },
      expanded: false,
      width: 120,
      expectedLines: ["● Read(banner.gif)"],
    },
    {
      name: "extensionless file identified by state.isImage",
      args: { path: "blobs/raw-image" },
      state: { isImage: true },
      expanded: true,
      width: 120,
      expectedLines: ["● Read(raw-image)", "  Path: /workspace/blobs/raw-image"],
    },
  ];

  for (const row of cases) {
    const component = read.renderCall!(
      row.args,
      theme,
      makeContext(row.args, { expanded: row.expanded, state: row.state ?? {} }),
    );
    const lines = renderedLines(component, row.width);
    assert.deepEqual(lines, row.expectedLines, row.name);
    assert.ok(!lines.some((line) => line.includes("..")), `${row.name} must not contain '..'`);
  }

  for (const expanded of [false, true]) {
    const args = { path: `very/deeply/nested/../folder/${longFilename}` };
    const expectedPath = `/workspace/very/deeply/folder/${longFilename}`;
    const component = read.renderCall!(args, theme, makeContext(args, { expanded }));
    for (const width of [24, 40]) {
      const lines = renderedLines(component, width);
      assert.ok(lines.length > 1, `expected wrapping at width ${width} (expanded=${expanded})`);
      assert.ok(lines.every((line) => visibleWidth(line) <= width), `exceeded width ${width}`);
      const joined = lines.map((line) => line.trim()).join("");
      assert.ok(!joined.includes("…"), `must not ellipsize at width ${width}`);
      assert.ok(joined.includes(longFilename), `lost filename characters at width ${width}`);
      if (expanded) {
        assert.ok(joined.includes(`Path:${expectedPath}`) || joined.includes(`Path: ${expectedPath}`), `lost path characters at width ${width}`);
        assert.ok(!joined.includes(".."), `resolved path must not keep '..'`);
      }
    }
  }
});

test("non-image read renderCall retains single-line ellipsized relative-path behavior", () => {
  const read = getCustomToolDefinition("read", "/workspace")!;
  const longPath = `src/${"segment/".repeat(20)}file.ts`;

  for (const expanded of [false, true]) {
    const shortCall = read.renderCall!({ path: "src/../lib/index.ts" }, theme, makeContext({ path: "src/../lib/index.ts" }, { expanded }));
    assert.deepEqual(renderedLines(shortCall, 120), ["● Read(lib/index.ts)"]);

    const longCall = read.renderCall!({ path: longPath }, theme, makeContext({ path: longPath }, { expanded }));
    const lines = renderedLines(longCall, 60);
    assert.equal(lines.length, 1);
    assert.ok(visibleWidth(lines[0]!) <= 60);
    assert.match(lines[0]!, /…/);
  }
});

test("collapsed image renderResult renders format from mimeType, original dimensions, and human-readable file size", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-gear-image-read-"));
  try {
    const diskPngPath = join(tempDir, "disk-shot.png");
    writeFileSync(diskPngPath, Buffer.alloc(1536));

    const smallPath = join(tempDir, "tiny.gif");
    writeFileSync(smallPath, Buffer.alloc(512));

    const read = getCustomToolDefinition("read", tempDir)!;

    const cases = [
      {
        name: "resized image parses original WxH and derives JPEG format from mimeType despite .png filename",
        args: { path: "misnamed.png" },
        result: {
          content: [
            {
              type: "text" as const,
              text: "Read image file [image/jpeg]\n[Image: original 4000x3000, displayed at 1600x1200. Multiply coordinates by 2.50 to map to original image.]",
            },
            { type: "image" as const, data: makeJpegBase64(1600, 1200), mimeType: "image/jpeg" },
          ],
          details: { fileSize: 2_621_440 },
        },
        expected: "└ JPEG · 4000×3000 · 2.5 MB",
      },
      {
        name: "unresized PNG reads dimensions via getImageDimensions and file size via statSync on relative path",
        args: { path: "./nested/../disk-shot.png" },
        result: {
          content: [
            { type: "text" as const, text: "Read image file [image/png]" },
            { type: "image" as const, data: makePngBase64(320, 240), mimeType: "image/png" },
          ],
          details: undefined,
        },
        expected: "└ PNG · 320×240 · 1.5 KB",
      },
      {
        name: "GIF reads dimensions and sub-KB byte size via statSync",
        args: { path: "tiny.gif" },
        result: {
          content: [
            { type: "text" as const, text: "Read image file [image/gif]" },
            { type: "image" as const, data: makeGifBase64(120, 80), mimeType: "image/gif" },
          ],
          details: undefined,
        },
        expected: "└ GIF · 120×80 · 512 B",
      },
      {
        name: "WEBP format and dimensions with KB fileSize from details",
        args: { path: "absent-on-disk.webp" },
        result: {
          content: [
            { type: "text" as const, text: "Read image file [image/webp]" },
            { type: "image" as const, data: makeWebpBase64(640, 480), mimeType: "image/webp" },
          ],
          details: { fileSize: 45 * 1024 },
        },
        expected: "└ WEBP · 640×480 · 45 KB",
      },
      {
        name: "BMP with unavailable dimensions omits dimensions gracefully",
        args: { path: "icon.bmp" },
        result: {
          content: [
            { type: "text" as const, text: "Read image file [image/bmp]" },
            { type: "image" as const, data: Buffer.from("BM").toString("base64"), mimeType: "image/bmp" },
          ],
          details: { fileSize: 800 },
        },
        expected: "└ BMP · 800 B",
      },
      {
        name: "missing file on disk and invalid image bytes omit both dimensions and size",
        args: { path: "missing.png" },
        result: {
          content: [
            { type: "text" as const, text: "Read image file [image/png; charset=binary]" },
            { type: "image" as const, data: "not-valid-base64-image", mimeType: "image/png; charset=binary" },
          ],
          details: undefined,
        },
        expected: "└ PNG",
      },
      {
        name: "unavailable size with valid dimensions omits size gracefully",
        args: { path: "missing-size.png" },
        result: {
          content: [
            { type: "text" as const, text: "Read image file [image/png]" },
            { type: "image" as const, data: makePngBase64(64, 32), mimeType: "image/png" },
          ],
          details: undefined,
        },
        expected: "└ PNG · 64×32",
      },
    ];

    for (const row of cases) {
      const contentSnapshot = structuredClone(row.result.content);
      const state: Record<string, unknown> = {};
      const component = read.renderResult!(
        row.result,
        { expanded: false, isPartial: false },
        theme,
        makeContext(row.args, { cwd: tempDir, expanded: false, state }),
      );
      assert.equal(renderedLines(component, 200).join("\n").trim(), row.expected, row.name);
      assert.equal(state.isImage, true, `${row.name} should mark state.isImage`);
      assert.deepEqual(row.result.content, contentSnapshot, `${row.name} must keep result.content unchanged`);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("expanded image renderResult preserves native Pi output, coordinate mapping, fallback, and indent", () => {
  const read = getCustomToolDefinition("read", "/workspace")!;
  const result = {
    content: [
      {
        type: "text" as const,
        text: "Read image file [image/png]\n[Image: original 2000x1000, displayed at 1000x500. Multiply coordinates by 2.00 to map to original image.]",
      },
      { type: "image" as const, data: makePngBase64(1000, 500), mimeType: "image/png" },
    ],
    details: { fileSize: 120 * 1024 },
  };
  const contentSnapshot = structuredClone(result.content);

  const collapsed = read.renderResult!(
    result,
    { expanded: false, isPartial: false },
    theme,
    makeContext({ path: "diagram.png" }, { expanded: false }),
  );

  const expanded = read.renderResult!(
    result,
    { expanded: true, isPartial: false },
    theme,
    makeContext({ path: "diagram.png" }, { expanded: true, lastComponent: collapsed, showImages: false }),
  );
  const lines = renderedLines(expanded, 200);
  const joined = lines.join("\n");

  assert.match(joined, /Read image file \[image\/png\]/);
  assert.match(joined, /original 2000x1000, displayed at 1000x500\. Multiply coordinates by 2\.00 to map to original image\./);
  assert.match(joined, /\[Image: \[image\/png\] 1000x500\]/);
  assert.ok(lines.filter((line) => line.trim()).every((line) => line.startsWith("  ")), "expanded native output must be indented by 2 spaces");
  assert.deepEqual(result.content, contentSnapshot);

  const expandedAgain = read.renderResult!(
    result,
    { expanded: true, isPartial: false },
    theme,
    makeContext({ path: "diagram.png" }, { expanded: true, lastComponent: expanded, showImages: true }),
  );
  assert.equal(expandedAgain, expanded);

  configureOutputPadding({ getSettings: () => ({ outputPad: 1 }) });
  try {
    const paddedCall = read.renderCall!(
      { path: "assets/diagram.png" },
      theme,
      makeContext({ path: "assets/diagram.png" }, { expanded: true }),
    );
    const paddedCallLines = renderedLines(paddedCall, 40);
    assert.ok(paddedCallLines.every((line) => visibleWidth(line) <= 40));
    assert.equal(paddedCallLines[0]!.trimEnd(), " ● Read(diagram.png)");
    assert.equal(paddedCallLines[1]!.trimEnd(), "   Path: /workspace/assets/diagram.png");
  } finally {
    configureOutputPadding({ getSettings: () => ({ outputPad: 0 }) });
  }
});

test("failed reads and non-image reads retain existing behavior", () => {
  const read = getCustomToolDefinition("read", "/workspace")!;

  const errorCases = [
    {
      name: "collapsed error on image path",
      expanded: false,
      text: "ENOENT: no such file or directory\nstack trace line",
      expected: ["  └ ENOENT: no such file or directory"],
    },
    {
      name: "expanded error on image path",
      expanded: true,
      text: "ENOENT: no such file or directory\nstack trace line",
      expected: ["  ENOENT: no such file or directory", "  stack trace line"],
    },
  ];

  for (const row of errorCases) {
    const state: Record<string, unknown> = {};
    const component = read.renderResult!(
      { content: [{ type: "text", text: row.text }], details: undefined },
      { expanded: row.expanded, isPartial: false },
      theme,
      makeContext({ path: "missing.png" }, { expanded: row.expanded, isError: true, state }),
    );
    assert.deepEqual(renderedLines(component, 200), row.expected, row.name);
    assert.equal(state.isImage, undefined, "failed read must not mark state.isImage");
  }

  const textOnlyPng = read.renderResult!(
    { content: [{ type: "text", text: "Read image file [image/tiff]\n[Image omitted: could not be converted]" }], details: undefined },
    { expanded: false, isPartial: false },
    theme,
    makeContext({ path: "unconverted.tiff" }, { expanded: false }),
  );
  assert.deepEqual(renderedLines(textOnlyPng, 200), ["  └ 2 lines"]);

  const textFile = read.renderResult!(
    { content: [{ type: "text", text: "alpha\nbeta\ngamma" }], details: undefined },
    { expanded: false, isPartial: false },
    theme,
    makeContext({ path: "src/app.ts" }, { expanded: false }),
  );
  assert.deepEqual(renderedLines(textFile, 200), ["  └ 3 lines"]);
});

test("failed image read renderCall renders ordinary error header without Path", () => {
  const read = getCustomToolDefinition("read", "/workspace")!;

  const cases = [
    {
      name: "collapsed error on .png",
      args: { path: "assets/missing.png" },
      expanded: false,
      state: {},
      expectedLines: ["✗ Read(assets/missing.png)"],
    },
    {
      name: "expanded error on .png",
      args: { path: "assets/missing.png" },
      expanded: true,
      state: {},
      expectedLines: ["✗ Read(assets/missing.png)"],
    },
    {
      name: "expanded error on .png with prior state.isImage",
      args: { path: "assets/missing.png" },
      expanded: true,
      state: { isImage: true },
      expectedLines: ["✗ Read(assets/missing.png)"],
    },
  ];

  for (const row of cases) {
    const component = read.renderCall!(
      row.args,
      theme,
      makeContext(row.args, { expanded: row.expanded, isError: true, state: row.state }),
    );
    const lines = renderedLines(component, 200);
    assert.deepEqual(lines, row.expectedLines, row.name);
    assert.ok(!lines.some((line) => line.includes("Path:")), `${row.name} must not render Path:`);
  }
});

test("read reconciles state.isImage and invalidates once when actual content differs from path guess", async () => {
  const read = getCustomToolDefinition("read", "/workspace")!;

  const cases = [
    {
      name: "text-only .png switches to ordinary read header",
      args: { path: "assets/fake.png", offset: 1, limit: 10 },
      result: {
        content: [{ type: "text" as const, text: "line 1\nline 2" }],
        details: undefined,
      },
      initialCollapsed: ["● Read(fake.png)"],
      expectedIsImage: false,
      expectedInvalidations: 1,
      reconciledCollapsed: ["● Read(assets/fake.png:1-10)"],
      reconciledExpanded: ["● Read(assets/fake.png:1-10)"],
    },
    {
      name: "extensionless image switches to image header",
      args: { path: "blobs/raw-image" },
      result: {
        content: [
          { type: "text" as const, text: "Read image file [image/png]" },
          { type: "image" as const, data: makePngBase64(16, 16), mimeType: "image/png" },
        ],
        details: { fileSize: 256 },
      },
      initialCollapsed: ["● Read(blobs/raw-image)"],
      expectedIsImage: true,
      expectedInvalidations: 1,
      reconciledCollapsed: ["● Read(raw-image)"],
      reconciledExpanded: ["● Read(raw-image)", "  Path: /workspace/blobs/raw-image"],
    },
  ];

  for (const row of cases) {
    const state: Record<string, unknown> = {};
    let invalidations = 0;
    const invalidate = () => {
      invalidations += 1;
    };

    const initialCall = read.renderCall!(
      row.args,
      theme,
      makeContext(row.args, { expanded: false, state, invalidate }),
    );
    assert.deepEqual(renderedLines(initialCall, 200), row.initialCollapsed, `${row.name} initial renderCall`);

    read.renderResult!(
      row.result,
      { expanded: false, isPartial: true },
      theme,
      makeContext(row.args, { expanded: false, isPartial: true, state, invalidate }),
    );
    await Promise.resolve();
    assert.equal(state.isImage, undefined, `${row.name} partial renderResult must not lock state.isImage`);
    assert.equal(invalidations, 0, `${row.name} partial renderResult must not invalidate`);

    read.renderResult!(
      row.result,
      { expanded: false, isPartial: false },
      theme,
      makeContext(row.args, { expanded: false, state, invalidate }),
    );
    assert.equal(state.isImage, row.expectedIsImage, `${row.name} state.isImage`);
    assert.equal(invalidations, 0, `${row.name} invalidations before microtask flush`);

    await Promise.resolve();
    assert.equal(invalidations, row.expectedInvalidations, `${row.name} invalidations after microtask flush`);

    const reconciledCollapsed = read.renderCall!(
      row.args,
      theme,
      makeContext(row.args, { expanded: false, state, invalidate }),
    );
    assert.deepEqual(
      renderedLines(reconciledCollapsed, 200),
      row.reconciledCollapsed,
      `${row.name} reconciled collapsed renderCall`,
    );

    const reconciledExpanded = read.renderCall!(
      row.args,
      theme,
      makeContext(row.args, { expanded: true, state, invalidate }),
    );
    assert.deepEqual(
      renderedLines(reconciledExpanded, 200),
      row.reconciledExpanded,
      `${row.name} reconciled expanded renderCall`,
    );

    read.renderResult!(
      row.result,
      { expanded: false, isPartial: false },
      theme,
      makeContext(row.args, { expanded: false, state, invalidate }),
    );
    read.renderResult!(
      row.result,
      { expanded: true, isPartial: false },
      theme,
      makeContext(row.args, { expanded: true, state, invalidate }),
    );
    await Promise.resolve();
    assert.equal(invalidations, row.expectedInvalidations, `${row.name} must not invalidate on re-render`);
  }
});

test("ToolExecutionComponent reconciles header without duplicating result blocks on microtask invalidation", async () => {
  const read = getCustomToolDefinition("read", "/workspace")!;

  const rawImageResult = {
    content: [
      { type: "text" as const, text: "Read image file [image/png]" },
      { type: "image" as const, data: makePngBase64(16, 16), mimeType: "image/png" },
    ],
    details: { fileSize: 256 },
  };
  const fakePngResult = {
    content: [{ type: "text" as const, text: "line 1\nline 2" }],
    details: undefined,
  };

  const cases = [
    {
      name: "blobs/raw-image collapsed",
      args: { path: "blobs/raw-image" },
      expanded: false,
      result: rawImageResult,
      expectedHeader: ["● Read(raw-image)"],
      expectedResultTokens: ["└ PNG · 16×16 · 256 B"],
    },
    {
      name: "blobs/raw-image expanded",
      args: { path: "blobs/raw-image" },
      expanded: true,
      result: rawImageResult,
      expectedHeader: ["● Read(raw-image)", "  Path: /workspace/blobs/raw-image"],
      expectedResultTokens: ["Read image file [image/png]", "[Image: [image/png] 16x16]"],
    },
    {
      name: "assets/fake.png collapsed",
      args: { path: "assets/fake.png", offset: 1, limit: 10 },
      expanded: false,
      result: fakePngResult,
      expectedHeader: ["● Read(assets/fake.png:1-10)"],
      expectedResultTokens: ["└ 2 lines"],
    },
  ];

  for (const row of cases) {
    let renderRequests = 0;
    const ui = {
      requestRender: () => {
        renderRequests += 1;
      },
    } as never;

    const component = new ToolExecutionComponent(
      "read",
      `tc-${row.name}`,
      row.args,
      { showImages: false },
      read,
      ui,
      "/workspace",
    );
    if (row.expanded) {
      component.setExpanded(true);
    }

    component.updateResult({ ...row.result, isError: false }, false);
    assert.equal(renderRequests, 0, `${row.name} must defer invalidation to a microtask`);

    await Promise.resolve();
    assert.equal(renderRequests, 1, `${row.name} must request exactly one re-render`);

    await Promise.resolve();
    assert.equal(renderRequests, 1, `${row.name} must not loop invalidations`);

    const lines = renderedLines(component, 200).map((line) => line.trimEnd());
    const nonEmpty = lines.filter(Boolean);

    assert.deepEqual(nonEmpty.slice(0, row.expectedHeader.length), row.expectedHeader, `${row.name} reconciled header`);
    for (const token of row.expectedResultTokens) {
      const matches = nonEmpty.filter((line) => line.includes(token));
      assert.equal(matches.length, 1, `${row.name} must render '${token}' exactly once, got:\n${nonEmpty.join("\n")}`);
    }
  }
});
