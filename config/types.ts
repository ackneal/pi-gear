export type FilesystemAccess = "deny" | "read-only" | "read-write";
export type NetworkAccess = "allow" | "deny";

export interface FilesystemRule {
  readonly path: string;
  readonly access: FilesystemAccess;
  /** When true, the rule's access also applies to the symlink-resolved target of a matching path. */
  readonly follow?: boolean;
}

export interface NetworkRule {
  readonly host: string;
  readonly access: NetworkAccess;
}

export interface AccessPolicy {
  readonly filesystem: {
    readonly rules: readonly FilesystemRule[];
  };
  readonly network: {
    readonly rules: readonly NetworkRule[];
  };
}

export interface LspServerConfig {
  readonly extensions: readonly string[];
  readonly command: readonly string[];
}

export interface LspConfig {
  readonly servers: readonly LspServerConfig[];
}

export interface ExtensionConfig extends AccessPolicy {
  readonly version: 1;
  readonly lsp?: LspConfig;
}
