import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseExtensionConfig } from "./parse.ts";
import type { ExtensionConfig, FilesystemRule } from "./types.ts";

const runtimeFilesystemDefaults: readonly FilesystemRule[] = Object.freeze([
  Object.freeze({ path: "/tmp/**", access: "read-write", follow: true }),
  Object.freeze({ path: join(getAgentDir(), "skills", "**"), access: "read-only", follow: true }),
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

let cachedConfig: Promise<ExtensionConfig> | undefined;

export const loadExtensionConfig = (): Promise<ExtensionConfig> => {
  if (cachedConfig !== undefined) return cachedConfig;

  let pending: Promise<ExtensionConfig>;
  pending = readFile(new URL("../config.json", import.meta.url), "utf8")
    .then((content) => withRuntimeDefaults(parseExtensionConfig(JSON.parse(content) as unknown)))
    .catch((error: unknown) => {
      if (cachedConfig === pending) cachedConfig = undefined;
      throw new Error(`Unable to load policy configuration: ${error instanceof Error ? error.message : String(error)}`);
    });
  cachedConfig = pending;
  return pending;
};
