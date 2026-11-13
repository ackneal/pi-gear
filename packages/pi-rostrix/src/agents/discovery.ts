import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { AgentDefinition } from "./schema.ts";
import { parseAgentJson, parseAgentMarkdown, AgentParseError } from "./parser.ts";

export interface DiscoveredAgent {
  readonly agent: AgentDefinition;
  readonly filePath: string;
  readonly scope: "user" | "project" | "custom";
}

export interface DiscoverAgentsOptions {
  readonly cwd?: string | undefined;
  readonly userDir?: string | undefined;
  readonly projectDir?: string | undefined;
  readonly customDirs?: string[] | undefined;
  readonly onWarning?: ((warning: string) => void) | undefined;
}

export interface AgentDiscoveryResult {
  readonly agents: DiscoveredAgent[];
  readonly errors: { filePath: string; error: string }[];
}

export async function discoverAllAgents(options: DiscoverAgentsOptions = {}): Promise<AgentDiscoveryResult> {
  const userDirs = options.userDir
    ? [options.userDir]
    : [
        path.join(os.homedir(), ".pi", "agent", "rostrix"),
        path.join(os.homedir(), ".pi", "agent", "profiles"),
      ];

  const projectDirs = options.projectDir
    ? [options.projectDir]
    : [
        options.cwd ? path.join(options.cwd, ".pi", "rostrix") : path.join(process.cwd(), ".pi", "rostrix"),
        options.cwd ? path.join(options.cwd, ".pi", "profiles") : path.join(process.cwd(), ".pi", "profiles"),
      ];

  const userResults: AgentDiscoveryResult[] = [];
  for (const dir of userDirs) {
    userResults.push(await scanAgentDirectory(dir, "user", options.onWarning));
  }

  const projectResults: AgentDiscoveryResult[] = [];
  for (const dir of projectDirs) {
    projectResults.push(await scanAgentDirectory(dir, "project", options.onWarning));
  }

  const customResults: AgentDiscoveryResult[] = [];
  if (options.customDirs) {
    for (const dir of options.customDirs) {
      customResults.push(await scanAgentDirectory(dir, "custom", options.onWarning));
    }
  }

  // Merge with precedence: custom > project > user (and primary dir > fallback dir)
  const agentsById = new Map<string, DiscoveredAgent>();

  for (const result of userResults) {
    for (const item of result.agents) {
      if (!agentsById.has(item.agent.id)) {
        agentsById.set(item.agent.id, item);
      }
    }
  }
  for (const result of projectResults) {
    for (const item of result.agents) {
      agentsById.set(item.agent.id, item);
    }
  }
  for (const custom of customResults) {
    for (const item of custom.agents) {
      agentsById.set(item.agent.id, item);
    }
  }

  const allErrors = [
    ...userResults.flatMap((r) => r.errors),
    ...projectResults.flatMap((r) => r.errors),
    ...customResults.flatMap((r) => r.errors),
  ];

  const agentList = Array.from(agentsById.values());

  return {
    agents: agentList,
    errors: allErrors,
  };
}

export async function scanAgentDirectory(
  dirPath: string,
  scope: "user" | "project" | "custom",
  onWarning?: ((warning: string) => void) | undefined,
): Promise<AgentDiscoveryResult> {
  const agents: DiscoveredAgent[] = [];
  const errors: { filePath: string; error: string }[] = [];

  let entries: string[];
  try {
    entries = await collectCandidateFiles(dirPath);
  } catch {
    return { agents, errors };
  }

  for (const filePath of entries) {
    const ext = path.extname(filePath).toLowerCase();
    const fallbackId = path.basename(filePath, ext);

    try {
      const content = await fs.readFile(filePath, "utf-8");
      let agent: AgentDefinition;

      if (ext === ".md") {
        agent = parseAgentMarkdown(content, { filePath, fallbackId });
      } else if (ext === ".json") {
        agent = parseAgentJson(content, { filePath, fallbackId });
      } else {
        continue;
      }

      agents.push({ agent, filePath, scope });
    } catch (err) {
      const msg = err instanceof AgentParseError ? err.message : String(err);
      errors.push({ filePath, error: msg });
      onWarning?.(`Failed to load agent from ${filePath}: ${msg}`);
    }
  }

  return { agents, errors };
}

async function collectCandidateFiles(dirPath: string): Promise<string[]> {
  const files: string[] = [];

  async function traverse(current: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        await traverse(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === ".md" || ext === ".json") {
          files.push(fullPath);
        }
      }
    }
  }

  await traverse(dirPath);
  return files.sort();
}

