import { readFile } from "node:fs/promises";
import { parseExtensionConfig } from "./parse.ts";
import type { ExtensionConfig } from "./types.ts";

let cachedConfig: Promise<ExtensionConfig> | undefined;

export const loadExtensionConfig = (): Promise<ExtensionConfig> => {
  if (cachedConfig !== undefined) return cachedConfig;

  let pending: Promise<ExtensionConfig>;
  pending = readFile(new URL("../config.json", import.meta.url), "utf8")
    .then((content) => parseExtensionConfig(JSON.parse(content) as unknown))
    .catch((error: unknown) => {
      if (cachedConfig === pending) cachedConfig = undefined;
      throw new Error(`Unable to load policy configuration: ${error instanceof Error ? error.message : String(error)}`);
    });
  cachedConfig = pending;
  return pending;
};
