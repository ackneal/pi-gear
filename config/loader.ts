import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { parseExtensionConfig } from "./parse.ts";
import type { ExtensionConfig, FilesystemRule } from "./types.ts";

const runtimeFilesystemDefaults: readonly FilesystemRule[] = Object.freeze([
  Object.freeze({ path: "/tmp", access: "read-write" }),
  Object.freeze({ path: "/private/tmp", access: "read-write" }),
  Object.freeze({ path: join(getAgentDir(), "skills"), access: "read-only", follow: true }),
]);

const withRuntimeDefaults = (config: ExtensionConfig): ExtensionConfig => {
  const configuredPaths = new Set(config.filesystem.rules.map((rule) => rule.path));
  const defaults = runtimeFilesystemDefaults.filter((rule) => !configuredPaths.has(rule.path));
  if (defaults.length === 0) return config;

  const filesystem = Object.freeze({
    ...config.filesystem,
    rules: Object.freeze([...defaults, ...config.filesystem.rules]),
  });
  return Object.freeze({ ...config, filesystem });
};

const bundledConfigUrl = new URL("../config.json", import.meta.url);
const getGlobalConfigPath = (): string => join(getAgentDir(), "pi-gear", "config.json");

const readConfig = async (): Promise<string> => {
  try {
    return await readFile(getGlobalConfigPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return readFile(bundledConfigUrl, "utf8");
  }
};

let cachedConfig: Promise<ExtensionConfig> | undefined;

export const loadExtensionConfig = (): Promise<ExtensionConfig> => {
  if (cachedConfig !== undefined) return cachedConfig;

  let pending: Promise<ExtensionConfig>;
  pending = readConfig()
    .then((content) => withRuntimeDefaults(parseExtensionConfig(JSON.parse(content) as unknown)))
    .catch((error: unknown) => {
      if (cachedConfig === pending) cachedConfig = undefined;
      throw new Error(`Unable to load policy configuration: ${error instanceof Error ? error.message : String(error)}`);
    });
  cachedConfig = pending;
  return pending;
};

export const appendAllowedNetworkHost = async (host: string): Promise<ExtensionConfig> => {
  const normalizedHost = host.toLowerCase();
  const configPath = getGlobalConfigPath();

  return withFileMutationQueue(configPath, async () => {
    let rawConfig: Record<string, unknown>;
    try {
      const content = await readFile(configPath, "utf8");
      rawConfig = JSON.parse(content) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const bundledContent = await readFile(bundledConfigUrl, "utf8");
      rawConfig = JSON.parse(bundledContent) as Record<string, unknown>;
    }

    const sandbox = (typeof rawConfig.sandbox === "object" && rawConfig.sandbox !== null && !Array.isArray(rawConfig.sandbox))
      ? { ...rawConfig.sandbox as Record<string, unknown> }
      : {};
    const network = (typeof sandbox.network === "object" && sandbox.network !== null && !Array.isArray(sandbox.network))
      ? { ...sandbox.network as Record<string, unknown> }
      : {};
    const rules = Array.isArray(network.rules) ? [...network.rules] : [];

    const existingIndex = rules.findIndex(
      (rule: unknown) => rule && typeof rule === "object" && "host" in rule && typeof (rule as { host: unknown }).host === "string" && (rule as { host: string }).host.toLowerCase() === normalizedHost,
    );

    if (existingIndex === -1) {
      rules.push({ host: normalizedHost, access: "allow" });
    } else {
      rules[existingIndex] = { host: normalizedHost, access: "allow" };
    }

    network.rules = rules;
    sandbox.network = network;
    rawConfig.sandbox = sandbox;

    const serialized = `${JSON.stringify(rawConfig, null, 2)}\n`;
    await mkdir(dirname(configPath), { recursive: true });
    const temporary = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, configPath);
    } finally {
      await rm(temporary, { force: true });
    }

    const updated = withRuntimeDefaults(parseExtensionConfig(rawConfig));
    cachedConfig = Promise.resolve(updated);
    return updated;
  });
};
