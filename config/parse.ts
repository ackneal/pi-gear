import { validFilesystemSelector } from "./selectors.ts";
import type { AccessPolicy, ExtensionConfig, FilesystemAccess, FilesystemRule, NetworkRule } from "./types.ts";
export type { AccessPolicy, ExtensionConfig, FilesystemAccess, FilesystemRule, NetworkAccess, NetworkRule } from "./types.ts";

const object = (value: unknown, name: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
};

const exactKeys = (
  value: Record<string, unknown>,
  name: string,
  keys: readonly string[],
  optional: readonly string[] = [],
): void => {
  const allowed = new Set([...keys, ...optional]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`${name} has invalid keys`);
  }
};

const version = (value: unknown): 1 => {
  if (value !== 1) {
    throw new Error("version must be 1");
  }
  return 1;
};

const readWriteDefault = (value: unknown): "read-write" => {
  if (value !== "read-write") {
    throw new Error('filesystem.workspaceDefault must be "read-write"');
  }
  return "read-write";
};

const askDefault = (value: unknown, name: string): "ask" => {
  if (value !== "ask") {
    throw new Error(`${name} must be "ask"`);
  }
  return "ask";
};

const string = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a nonempty string`);
  }
  return value;
};

const filesystemRule = (value: unknown, index: number): FilesystemRule => {
  const rule = object(value, `filesystem.rules[${index}]`);
  exactKeys(rule, `filesystem.rules[${index}]`, ["path", "access"], ["follow"]);
  const access = string(rule.access, `filesystem.rules[${index}].access`);
  if (access !== "deny" && access !== "read-only" && access !== "read-write") {
    throw new Error(`filesystem.rules[${index}].access is invalid`);
  }
  const path = string(rule.path, `filesystem.rules[${index}].path`);
  if (!validFilesystemSelector(path)) {
    throw new Error(`filesystem.rules[${index}].path is invalid`);
  }
  if (rule.follow !== undefined && typeof rule.follow !== "boolean") {
    throw new Error(`filesystem.rules[${index}].follow must be a boolean`);
  }
  return Object.freeze({
    path,
    access,
    ...(rule.follow === undefined ? {} : { follow: rule.follow }),
  });
};

const validDnsName = (host: string): boolean =>
  host.length <= 253 && host.split(".").every((label) =>
    label.length > 0 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
  );

const validHost = (host: string): boolean => {
  const separator = host.lastIndexOf(":");
  const name = separator === -1 ? host : host.slice(0, separator);
  const port = separator === -1 ? undefined : host.slice(separator + 1);
  const dnsName = name.startsWith("*.") ? name.slice(2) : name;
  if (!validDnsName(dnsName)) {
    return false;
  }
  return port === undefined ||
    /^(?:[1-9][0-9]{0,4})$/.test(port) && Number(port) <= 65_535;
};

const networkRule = (value: unknown, index: number): NetworkRule => {
  const rule = object(value, `network.rules[${index}]`);
  exactKeys(rule, `network.rules[${index}]`, ["host", "access"]);
  const host = string(rule.host, `network.rules[${index}].host`).toLowerCase();
  if (!validHost(host)) {
    throw new Error(`network.rules[${index}].host is invalid`);
  }
  const access = string(rule.access, `network.rules[${index}].access`);
  if (access !== "allow" && access !== "deny") {
    throw new Error(`network.rules[${index}].access is invalid`);
  }
  return Object.freeze({ host, access });
};

const filesystemRules = (
  value: unknown,
): readonly FilesystemRule[] => {
  if (!Array.isArray(value)) {
    throw new Error("filesystem.rules must be an array");
  }
  const parsed = value.map(filesystemRule);
  const selectors = new Set<string>();
  for (const rule of parsed) {
    if (selectors.has(rule.path)) {
      throw new Error(`filesystem.rules contains duplicate path ${rule.path}`);
    }
    selectors.add(rule.path);
  }
  return Object.freeze(parsed);
};

const networkRules = (value: unknown): readonly NetworkRule[] => {
  if (!Array.isArray(value)) {
    throw new Error("network.rules must be an array");
  }
  return Object.freeze(value.map(networkRule));
};

export const parseExtensionConfig = (value: unknown): ExtensionConfig => {
  try {
    const root = object(value, "config");
    exactKeys(root, "config", ["version", "filesystem", "network"]);
    const filesystem = object(root.filesystem, "filesystem");
    exactKeys(filesystem, "filesystem", [
      "workspaceDefault",
      "outsideWorkspaceDefault",
      "rules",
    ]);
    const network = object(root.network, "network");
    exactKeys(network, "network", ["defaultAccess", "rules"]);

    const policy: AccessPolicy = {
      filesystem: {
        workspaceDefault: readWriteDefault(filesystem.workspaceDefault),
        outsideWorkspaceDefault: askDefault(
          filesystem.outsideWorkspaceDefault,
          "filesystem.outsideWorkspaceDefault",
        ),
        rules: filesystemRules(filesystem.rules),
      },
      network: {
        defaultAccess: askDefault(network.defaultAccess, "network.defaultAccess"),
        rules: networkRules(network.rules),
      },
    };

    Object.freeze(policy.filesystem);
    Object.freeze(policy.network);
    return Object.freeze({
      version: version(root.version),
      ...policy,
    });
  } catch (error) {
    throw new Error(
      `Invalid policy configuration: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
