import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { AccessPolicy, ExtensionConfig } from "../../config/types.ts";

interface SandboxConfigModule {
  readonly createEffectiveSandboxConfig: (workspaceRoot: string, policy: AccessPolicy) => Promise<SandboxRuntimeConfig>;
}

interface ExtensionConfigModule {
  readonly parseExtensionConfig: (value: unknown) => ExtensionConfig;
}

const loadSandboxRuntime = async (): Promise<{
  readonly root: string;
  readonly sandbox: SandboxConfigModule;
  readonly config: ExtensionConfigModule;
}> => {
  const root = await mkdtemp(join(tmpdir(), "pi-gear-sandbox-runtime-"));
  const modules = [
    ["config.ts", "sandbox/config.ts"],
    ["../../config/types.ts", "config/types.ts"],
    ["../../config/selectors.ts", "config/selectors.ts"],
    ["../../config/parse.ts", "config/parse.ts"],
    ["../policy/filesystem.ts", "policy/filesystem.ts"],
  ] as const;
  for (const [sourcePath, destination] of modules) {
    const destinationPath = join(root, destination);
    await mkdir(dirname(destinationPath), { recursive: true });
    await writeFile(destinationPath, await readFile(new URL(sourcePath, import.meta.url), "utf8"));
  }
  await writeFile(join(root, "package.json"), '{"type":"module"}\n');
  await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"));
  return {
    root,
    sandbox: await import(pathToFileURL(join(root, "sandbox/config.ts")).href) as SandboxConfigModule,
    config: await import(pathToFileURL(join(root, "config/parse.ts")).href) as ExtensionConfigModule,
  };
};

const runSandboxed = async (command: string, cwd: string, config: SandboxRuntimeConfig): Promise<{ readonly exitCode: number | null; readonly output: string }> => {
  const wrapped = await SandboxManager.wrapWithSandbox(command, "bash", config);
  return await new Promise((resolve, reject) => {
    let output = "";
    const child = spawn("bash", ["-c", wrapped], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (data: Buffer) => { output += data; });
    child.stderr.on("data", (data: Buffer) => { output += data; });
    child.on("error", reject);
    child.on("close", (exitCode: number | null) => {
      SandboxManager.cleanupAfterCommand();
      resolve({ exitCode, output });
    });
  });
};

test("extension sandbox permits ordinary workspace work and broad host reads", {
  concurrency: false,
  skip: process.platform !== "darwin",
}, async () => {
  await assert.doesNotReject(access("/usr/bin/sandbox-exec"));
  assert.equal(SandboxManager.isSupportedPlatform(), true);
  const dependencies = await SandboxManager.checkDependenciesAsync();
  assert.deepEqual(dependencies.errors, []);
  const root = await mkdtemp(join(tmpdir(), "pi-gear-sandbox-"));
  const workspace = join(root, "workspace");
  const outsideFile = join(root, "outside.txt");
  const ordinaryFile = join(workspace, "ordinary.txt");
  const runtime = await loadSandboxRuntime();
  try {
    await mkdir(workspace);
    await Promise.all([writeFile(ordinaryFile, "ordinary"), writeFile(outsideFile, "outside")]);
    const config = runtime.config.parseExtensionConfig(JSON.parse(await readFile(new URL("../../config.json", import.meta.url), "utf8")) as unknown);
    const sandbox = await runtime.sandbox.createEffectiveSandboxConfig(workspace, config);
    if (SandboxManager.isSandboxingEnabled()) await SandboxManager.reset();
    await SandboxManager.initialize(sandbox, async () => false);
    const secretFile = join(workspace, ".env");
    await writeFile(secretFile, "secret");
    const result = await runSandboxed(`[[ $(< '${ordinaryFile}') == ordinary ]] && printf changed > '${ordinaryFile}' && [[ $(< '${outsideFile}') == outside ]]`, workspace, sandbox);
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(await readFile(ordinaryFile, "utf8"), "changed");
    const outsideWrite = await runSandboxed(`printf escaped > '${outsideFile}'`, workspace, sandbox);
    assert.notEqual(outsideWrite.exitCode, 0, outsideWrite.output);
    assert.equal(await readFile(outsideFile, "utf8"), "outside");
    const secretRead = await runSandboxed(`cat '${secretFile}'`, workspace, sandbox);
    assert.notEqual(secretRead.exitCode, 0, secretRead.output);
  } finally {
    if (SandboxManager.isSandboxingEnabled()) await SandboxManager.reset();
    await rm(root, { recursive: true, force: true });
    await rm(runtime.root, { recursive: true, force: true });
  }
});
