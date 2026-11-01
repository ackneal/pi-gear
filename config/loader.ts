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

const readRawConfig = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readConfig()) as Record<string, unknown>;

let cachedConfig: Promise<ExtensionConfig> | undefined;

export const loadExtensionConfig = async (): Promise<ExtensionConfig> => {
  if (cachedConfig !== undefined) return cachedConfig;

  let pending: Promise<ExtensionConfig>;
  pending = readRawConfig()
    .then((raw) => withRuntimeDefaults(parseExtensionConfig(raw)))
    .catch((error: unknown) => {
      if (cachedConfig === pending) cachedConfig = undefined;
      throw new Error(`Unable to load policy configuration: ${error instanceof Error ? error.message : String(error)}`);
    });
  cachedConfig = pending;
  return pending;
};

export const appendAllowedNetworkHost = async (host: string): Promise<ExtensionConfig> => {
  const normalized = host.toLowerCase();
  const configPath = getGlobalConfigPath();

  return withFileMutationQueue(configPath, async () => {
    const raw = await readRawConfig();
    const sandbox = (raw.sandbox ?? {}) as Record<string, unknown>;
    const network = (sandbox.network ?? {}) as Record<string, unknown>;
    const existingRules = Array.isArray(network.rules) ? network.rules as Array<{ host?: string; access?: string }> : [];

    const filtered = existingRules.filter((rule) => rule?.host?.toLowerCase() !== normalized);
    const updatedRaw = {
      ...raw,
      sandbox: {
        ...sandbox,
        network: {
          ...network,
          rules: [...filtered, { host: normalized, access: "allow" }],
        },
      },
    };

    const serialized = `${JSON.stringify(updatedRaw, null, 2)}\n`;
    await mkdir(dirname(configPath), { recursive: true });
    const temporary = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, configPath);
    } finally {
      await rm(temporary, { force: true });
    }

    const updated = withRuntimeDefaults(parseExtensionConfig(updatedRaw));
    cachedConfig = Promise.resolve(updated);
    return updated;
  });
};
