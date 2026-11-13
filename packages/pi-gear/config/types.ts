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
  readonly sandbox: {
    readonly enabled: boolean;
    readonly network: {
      readonly rules: readonly NetworkRule[];
      readonly strictAllowlist: boolean;
    };
  };
}

export interface LspServerConfig {
  readonly extensions: readonly string[];
  readonly languageIds: Readonly<Record<string, string>>;
  readonly command: readonly string[];
}

export interface LspConfig {
  readonly servers: readonly LspServerConfig[];
  readonly idleTimeoutMinutes?: number;
}

export interface ExtensionConfig extends AccessPolicy {
  readonly $schema?: string;
  readonly version: 1;
  readonly lsp?: LspConfig;
}
