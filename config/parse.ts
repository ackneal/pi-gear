import { validFilesystemSelector } from "./selectors.ts";
import type {
  AccessPolicy,
  ExtensionConfig,
  FilesystemAccess,
  FilesystemRule,
  LspConfig,
  LspServerConfig,
  NetworkRule,
} from "./types.ts";
export type {
  AccessPolicy,
  ExtensionConfig,
  FilesystemAccess,
  FilesystemRule,
  LspConfig,
  LspServerConfig,
  NetworkAccess,
  NetworkRule,
} from "./types.ts";

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

const nonemptyStringArray = (value: unknown, name: string): readonly string[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a nonempty array`);
  }
  return Object.freeze(value.map((entry, index) => string(entry, `${name}[${index}]`)));
};

const MAX_IDLE_TIMEOUT_MINUTES = Math.floor(2_147_483_647 / 60_000);

const lspConfig = (value: unknown): LspConfig => {
  const lsp = object(value, "lsp");
  exactKeys(lsp, "lsp", ["servers"], ["idleTimeoutMinutes"]);
  if (!Array.isArray(lsp.servers)) throw new Error("lsp.servers must be an array");
  const idleTimeoutMinutes = lsp.idleTimeoutMinutes === undefined ? 15 : lsp.idleTimeoutMinutes;
  if (
    typeof idleTimeoutMinutes !== "number" ||
    !Number.isFinite(idleTimeoutMinutes) ||
    idleTimeoutMinutes < 0 ||
    idleTimeoutMinutes > MAX_IDLE_TIMEOUT_MINUTES
  ) {
    throw new Error(`lsp.idleTimeoutMinutes must be between 0 and ${MAX_IDLE_TIMEOUT_MINUTES}`);
  }

  const ownedExtensions = new Set<string>();
  const servers = lsp.servers.map((value, index): LspServerConfig => {
    const name = `lsp.servers[${index}]`;
    const server = object(value, name);
    exactKeys(server, name, ["extensions", "languageIds", "command"]);
    const extensions = nonemptyStringArray(server.extensions, `${name}.extensions`);
    for (const extension of extensions) {
      if (!/^\.[^./\\]+$/.test(extension)) {
        throw new Error(`${name}.extensions contains invalid extension ${extension}`);
      }
      if (ownedExtensions.has(extension)) {
        throw new Error(`lsp.servers contains duplicate extension ${extension}`);
      }
      ownedExtensions.add(extension);
    }

    const languageIdsValue = object(server.languageIds, `${name}.languageIds`);
    exactKeys(languageIdsValue, `${name}.languageIds`, extensions);
    const languageIds = Object.freeze(Object.fromEntries(
      extensions.map((extension) => [
        extension,
        string(languageIdsValue[extension], `${name}.languageIds[${JSON.stringify(extension)}]`),
      ]),
    ));

    return Object.freeze({
      extensions,
      languageIds,
      command: nonemptyStringArray(server.command, `${name}.command`),
    });
  });

  return Object.freeze({
    servers: Object.freeze(servers),
    idleTimeoutMinutes,
  });
};

export const parseExtensionConfig = (value: unknown): ExtensionConfig => {
  try {
    const root = object(value, "config");
    exactKeys(root, "config", ["version", "filesystem", "network"], ["lsp"]);
    const filesystem = object(root.filesystem, "filesystem");
    exactKeys(filesystem, "filesystem", ["rules"]);
    const network = object(root.network, "network");
    exactKeys(network, "network", ["rules"]);

    const policy: AccessPolicy = {
      filesystem: {
        rules: filesystemRules(filesystem.rules),
      },
      network: {
        rules: networkRules(network.rules),
      },
    };

    Object.freeze(policy.filesystem);
    Object.freeze(policy.network);
    return Object.freeze({
      version: version(root.version),
      ...policy,
      ...(root.lsp === undefined ? {} : { lsp: lspConfig(root.lsp) }),
    });
  } catch (error) {
    throw new Error(
      `Invalid policy configuration: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
