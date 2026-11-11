import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AgentActivator } from "./core/activator.ts";
import { AgentRegistry } from "./core/registry.ts";
import { AgentResolver, type ParentContextLimits, type ResolvedAgent } from "./core/resolver.ts";
import type { AgentDefinition } from "./core/schema.ts";
import {
  discoverAllAgents,
  type DiscoveredAgent,
  type DiscoverAgentsOptions,
  type AgentDiscoveryResult,
} from "./loader/discovery.ts";
import { setupInteractiveAgents } from "./interactive/index.ts";
import { TaskRegistry } from "./runtime/task-registry.ts";
import { TaskSupervisor } from "./supervision/supervisor.ts";
import { applySupervisionPrompt } from "./supervision/prompt.ts";
import { registerRostrixTools } from "./tools/index.ts";

export * from "./core/schema.ts";
export * from "./core/registry.ts";
export * from "./core/resolver.ts";
export * from "./core/activator.ts";
export * from "./loader/index.ts";
export * from "./interactive/index.ts";
export * from "./runtime/session-runner.ts";
export * from "./runtime/task-types.ts";
export * from "./runtime/task-registry.ts";
export * from "./supervision/inbox.ts";
export * from "./supervision/wake-up.ts";
export * from "./supervision/supervisor.ts";
export * from "./tools/index.ts";

export const ROSTRIX_RUNTIME_SYMBOL = Symbol.for("pi.rostrix.runtime");

export interface RostrixOptions {
  autoRegisterTools?: boolean;
  autoLoadAgents?: boolean;
  autoLoadProfiles?: boolean; // alias
  autoRegisterInteractive?: boolean;
  commandName?: string | false;
  shortcut?: string;
  statusKey?: string;
}

export interface RostrixRuntime {
  readonly version: string;
  readonly isInitialized: boolean;
  readonly agents: AgentRegistry;
  readonly profiles: AgentRegistry; // alias
  readonly resolver: AgentResolver;
  readonly activator: AgentActivator;
  readonly tasks: TaskRegistry;
  readonly supervisor: TaskSupervisor;
  registerDelegationTools(names: readonly string[]): void;
  readonly discoveredAgents: readonly DiscoveredAgent[];
  readonly discoveredProfiles: readonly DiscoveredAgent[]; // alias
  registerAgent(agent: AgentDefinition): void;
  registerProfile(profile: AgentDefinition): void; // alias
  getAgent(id: string): AgentDefinition | undefined;
  getProfile(id: string): AgentDefinition | undefined; // alias
  getAllAgents(): AgentDefinition[];
  getAllProfiles(): AgentDefinition[]; // alias
  resolveAgent(id: string, limits?: ParentContextLimits | undefined): ResolvedAgent;
  resolveProfile(id: string, limits?: ParentContextLimits | undefined): ResolvedAgent; // alias
  activateAgent(id: string): Promise<void>;
  activateProfile(id: string): Promise<void>; // alias
  deactivateAgent(): void;
  deactivateProfile(): void; // alias
  getActiveAgent(): ResolvedAgent | undefined;
  getActiveProfile(): ResolvedAgent | undefined; // alias
  loadDiscoveredAgents(options?: DiscoverAgentsOptions): Promise<AgentDiscoveryResult>;
  loadDiscoveredProfiles(options?: DiscoverAgentsOptions): Promise<AgentDiscoveryResult>; // alias
  dispose(): Promise<void>;
}

class InProcessRostrixRuntime implements RostrixRuntime {
  readonly version = "0.1.0";
  private _initialized = false;
  private _disposePromise?: Promise<void>;
  private readonly _agents = new AgentRegistry();
  private readonly _resolver = new AgentResolver(this._agents);
  private readonly _activator: AgentActivator;
  private readonly _tasks: TaskRegistry;
  private readonly _supervisor: TaskSupervisor;
  private readonly _pi: ExtensionAPI;
  private readonly _unsubscribeTasks: () => void;
  private readonly _removeSupervisionPrompt: () => void;
  private readonly _delegationTools = new Set<string>();
  private _discoveredAgents: DiscoveredAgent[] = [];

  constructor(pi: ExtensionAPI, options: RostrixOptions = {}) {
    this._pi = pi;
    this._activator = new AgentActivator(pi);
    this._tasks = new TaskRegistry();
    this._supervisor = new TaskSupervisor(this._tasks, pi);
    this._initialized = true;

    this._unsubscribeTasks = this._tasks.subscribe("*", (task) => {
      if (task.status === "completed" || task.status === "failed" || task.status === "aborted") {
        this._supervisor.notifyTaskSettled(task);
      }
    });

    this._removeSupervisionPrompt = pi.on("before_agent_start", (event) => {
      const canDelegate = event.systemPromptOptions.selectedTools.some((name) => this._delegationTools.has(name));
      applySupervisionPrompt(event.systemPromptOptions, canDelegate || this._tasks.listTasks().length > 0);
    });

    if (options.autoRegisterTools !== false) {
      this.registerDelegationTools(["delegate"]);
      registerRostrixTools({
        pi,
        taskRegistry: this._tasks,
        agentRegistry: this._agents,
        agentResolver: this._resolver,
        taskSupervisor: this._supervisor,
        getParentContext: () => ({ agent: this._activator.activeAgent }),
      });
    }

    if (options.autoRegisterInteractive !== false && options.commandName !== false) {
      setupInteractiveAgents({
        pi,
        runtime: this,
        shortcut: options.shortcut,
        commandName: options.commandName ?? "rostrix:agents",
        statusKey: options.statusKey,
      });
    }

    const shouldAutoLoad = (options.autoLoadAgents !== false) && (options.autoLoadProfiles !== false);
    if (shouldAutoLoad) {
      this.loadDiscoveredAgents().catch(() => {});
    }

    pi.on("session_shutdown", () => this.dispose());
  }

  get isInitialized(): boolean {
    return this._initialized;
  }

  get agents(): AgentRegistry {
    return this._agents;
  }

  get profiles(): AgentRegistry {
    return this._agents;
  }

  get resolver(): AgentResolver {
    return this._resolver;
  }

  get activator(): AgentActivator {
    return this._activator;
  }

  get tasks(): TaskRegistry {
    return this._tasks;
  }

  get supervisor(): TaskSupervisor {
    return this._supervisor;
  }

  registerDelegationTools(names: readonly string[]): void {
    for (const name of names) this._delegationTools.add(name);
  }

  get discoveredAgents(): readonly DiscoveredAgent[] {
    return this._discoveredAgents;
  }

  get discoveredProfiles(): readonly DiscoveredAgent[] {
    return this._discoveredAgents;
  }

  registerAgent(agent: AgentDefinition): void {
    this._agents.register(agent);
  }

  registerProfile(profile: AgentDefinition): void {
    this._agents.register(profile);
  }

  getAgent(id: string): AgentDefinition | undefined {
    return this._agents.get(id);
  }

  getProfile(id: string): AgentDefinition | undefined {
    return this._agents.get(id);
  }

  getAllAgents(): AgentDefinition[] {
    return this._agents.list();
  }

  getAllProfiles(): AgentDefinition[] {
    return this._agents.list();
  }

  resolveAgent(id: string, limits?: ParentContextLimits | undefined): ResolvedAgent {
    return this._resolver.resolve(id, limits);
  }

  resolveProfile(id: string, limits?: ParentContextLimits | undefined): ResolvedAgent {
    return this._resolver.resolve(id, limits);
  }

  async activateAgent(id: string): Promise<void> {
    const resolved = this.resolveAgent(id);
    await this._activator.activate(resolved);
  }

  async activateProfile(id: string): Promise<void> {
    await this.activateAgent(id);
  }

  deactivateAgent(): void {
    this._activator.deactivate();
  }

  deactivateProfile(): void {
    this.deactivateAgent();
  }

  getActiveAgent(): ResolvedAgent | undefined {
    return this._activator.activeAgent;
  }

  getActiveProfile(): ResolvedAgent | undefined {
    return this._activator.activeAgent;
  }

  async loadDiscoveredAgents(options?: DiscoverAgentsOptions): Promise<AgentDiscoveryResult> {
    const result = await discoverAllAgents(options);
    this._discoveredAgents = [...result.agents];

    for (const item of result.agents) {
      this._agents.register(item.agent);
    }

    return result;
  }

  async loadDiscoveredProfiles(options?: DiscoverAgentsOptions): Promise<AgentDiscoveryResult> {
    return this.loadDiscoveredAgents(options);
  }

  dispose(): Promise<void> {
    if (!this._disposePromise) {
      this._unsubscribeTasks();
      this._removeSupervisionPrompt();
      this._delegationTools.clear();
      this._supervisor.dispose();
      this._disposePromise = this._tasks.shutdown().finally(() => {
        this._activator.dispose();
        this._agents.clear();
        this._discoveredAgents = [];
        this._initialized = false;
        delete (globalThis as any)[ROSTRIX_RUNTIME_SYMBOL];
      });
    }
    return this._disposePromise;
  }
}

export function initRostrix(pi: ExtensionAPI, options: RostrixOptions = {}): RostrixRuntime {
  const globalObj = globalThis as any;
  if (globalObj[ROSTRIX_RUNTIME_SYMBOL]) {
    return globalObj[ROSTRIX_RUNTIME_SYMBOL] as RostrixRuntime;
  }

  const runtime = new InProcessRostrixRuntime(pi, options);
  globalObj[ROSTRIX_RUNTIME_SYMBOL] = runtime;
  return runtime;
}
