import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AgentActivator } from "./agents/activator.ts";
import { AgentRegistry } from "./agents/registry.ts";
import { AgentResolver, type ParentDelegationLimits, type ResolvedAgentDefinition } from "./agents/resolver.ts";
import type { AgentDefinition } from "./agents/schema.ts";
import {
  discoverAllAgents,
  type DiscoveredAgent,
  type DiscoverAgentsOptions,
  type AgentDiscoveryResult,
} from "./agents/discovery.ts";
import { registerAgentControls } from "./interactive/index.ts";
import { TaskController } from "./tasks/controller.ts";
import { TaskMonitor } from "./tasks/monitor.ts";
import { applyTaskCoordinationPrompt } from "./tools/coordination-prompt.ts";
import { registerTaskTools } from "./tools/index.ts";

export const RUNTIME_SYMBOL = Symbol.for("pi.rostrix.runtime");

export interface RuntimeOptions {
  autoRegisterTaskTools?: boolean;
  autoLoadDefinitions?: boolean;
  autoRegisterAgentControls?: boolean;
  commandName?: string | false;
  shortcut?: string;
  statusKey?: string;
}

export interface Runtime {
  readonly version: string;
  readonly isInitialized: boolean;
  readonly agents: AgentRegistry;
  readonly resolver: AgentResolver;
  readonly activator: AgentActivator;
  readonly tasks: TaskController;
  readonly monitor: TaskMonitor;
  addDelegationToolNames(names: readonly string[]): void;
  readonly discoveredAgents: readonly DiscoveredAgent[];
  registerAgent(agent: AgentDefinition): void;
  getAgent(id: string): AgentDefinition | undefined;
  getAllAgents(): AgentDefinition[];
  resolveAgent(id: string, limits?: ParentDelegationLimits | undefined): ResolvedAgentDefinition;
  activateAgent(id: string): Promise<void>;
  deactivateAgent(): void;
  getActiveAgent(): ResolvedAgentDefinition | undefined;
  loadAgentDefinitions(options?: DiscoverAgentsOptions): Promise<AgentDiscoveryResult>;
  dispose(): Promise<void>;
}

class RuntimeImpl implements Runtime {
  readonly version = "0.1.0";
  private _initialized = false;
  private _disposePromise?: Promise<void>;
  private readonly _agents = new AgentRegistry();
  private readonly _resolver = new AgentResolver(this._agents);
  private readonly _activator: AgentActivator;
  private readonly _tasks: TaskController;
  private readonly _monitor: TaskMonitor;
  private readonly _unsubscribeTasks: () => void;
  private readonly _removeCoordinationPrompt: () => void;
  private readonly _removeShutdownHook: () => void;
  private readonly _delegationToolNames = new Set<string>();
  private _toolsRegistered = false;
  private _interactiveStatusKey?: string;
  private _shortcutRegistered = false;
  private _discoveryPromise?: Promise<AgentDiscoveryResult> | undefined;
  private _discoveredAgents: DiscoveredAgent[] = [];

  constructor(pi: ExtensionAPI) {
    this._activator = new AgentActivator(pi);
    this._tasks = new TaskController();
    this._monitor = new TaskMonitor(this._tasks, pi);
    this._initialized = true;

    this._unsubscribeTasks = this._tasks.subscribe("*", (task) => {
      if (task.status === "completed" || task.status === "failed" || task.status === "aborted") {
        this._monitor.notifyTaskSettled(task);
      }
    });

    this._removeCoordinationPrompt = pi.on("before_agent_start", (event) => {
      const canDelegate = event.systemPromptOptions.selectedTools.some((name) => this._delegationToolNames.has(name));
      applyTaskCoordinationPrompt(event.systemPromptOptions, canDelegate || this._tasks.listTasks().length > 0);
    });

    this._removeShutdownHook = pi.on("session_shutdown", () => this.dispose());
  }

  enableFeatures(pi: ExtensionAPI, options: RuntimeOptions): void {
    if (this._disposePromise) {
      throw new Error("Cannot initialize Rostrix while its runtime is disposing or disposed");
    }

    if (options.autoRegisterTaskTools !== false && !this._toolsRegistered) {
      registerTaskTools({
        pi,
        taskController: this._tasks,
        agentResolver: this._resolver,
        taskMonitor: this._monitor,
        getParentState: () => ({ agent: this._activator.activeAgent }),
      });
      this.addDelegationToolNames(["delegate"]);
      this._toolsRegistered = true;
    }

    if (options.autoRegisterAgentControls !== false && options.commandName !== false) {
      if (this._interactiveStatusKey === undefined) {
        const statusKey = options.statusKey ?? "rostrix:agent";
        registerAgentControls({
          pi,
          runtime: this,
          commandName: options.commandName ?? "rostrix:agents",
          statusKey,
        });
        this._interactiveStatusKey = statusKey;
      }

      if (options.shortcut && !this._shortcutRegistered) {
        registerAgentControls({
          pi,
          runtime: this,
          commandName: false,
          shortcut: options.shortcut,
          statusKey: this._interactiveStatusKey,
        });
        this._shortcutRegistered = true;
      }
    }

    const shouldAutoLoad = options.autoLoadDefinitions !== false;
    if (shouldAutoLoad && !this._discoveryPromise) {
      this.loadAgentDefinitions().catch(() => {});
    }
  }

  get isInitialized(): boolean {
    return this._initialized;
  }

  get agents(): AgentRegistry {
    return this._agents;
  }

  get resolver(): AgentResolver {
    return this._resolver;
  }

  get activator(): AgentActivator {
    return this._activator;
  }

  get tasks(): TaskController {
    return this._tasks;
  }

  get monitor(): TaskMonitor {
    return this._monitor;
  }

  addDelegationToolNames(names: readonly string[]): void {
    for (const name of names) this._delegationToolNames.add(name);
  }

  get discoveredAgents(): readonly DiscoveredAgent[] {
    return this._discoveredAgents;
  }

  registerAgent(agent: AgentDefinition): void {
    this._agents.register(agent);
  }

  getAgent(id: string): AgentDefinition | undefined {
    return this._agents.get(id);
  }

  getAllAgents(): AgentDefinition[] {
    return this._agents.list();
  }

  resolveAgent(id: string, limits?: ParentDelegationLimits | undefined): ResolvedAgentDefinition {
    return this._resolver.resolve(id, limits);
  }

  async activateAgent(id: string): Promise<void> {
    const resolved = this.resolveAgent(id);
    await this._activator.activate(resolved);
  }

  deactivateAgent(): void {
    this._activator.deactivate();
  }

  getActiveAgent(): ResolvedAgentDefinition | undefined {
    return this._activator.activeAgent;
  }

  async loadAgentDefinitions(options?: DiscoverAgentsOptions): Promise<AgentDiscoveryResult> {
    if (this._disposePromise) {
      throw new Error("Cannot discover agents while the Rostrix runtime is disposing or disposed");
    }

    const discovery = discoverAllAgents(options).then((result) => {
      if (this._disposePromise) return result;

      for (const item of result.agents) {
        if (!this._agents.has(item.agent.id)) {
          this._agents.register(item.agent);
        }
      }
      this._discoveredAgents = [...result.agents];
      return result;
    });
    this._discoveryPromise ??= discovery;
    return discovery;
  }

  dispose(): Promise<void> {
    if (!this._disposePromise) {
      this._disposePromise = this._tasks.shutdown().finally(() => {
        this._activator.dispose();
        this._agents.clear();
        this._discoveredAgents = [];
        this._discoveryPromise = undefined;
        this._initialized = false;
        delete (globalThis as any)[RUNTIME_SYMBOL];
      });

      this._unsubscribeTasks();
      this._removeCoordinationPrompt();
      this._removeShutdownHook();
      this._delegationToolNames.clear();
      this._monitor.dispose();
    }
    return this._disposePromise;
  }
}

/** Add enabled features to the shared runtime without replacing existing registrations. */
export function init(pi: ExtensionAPI, options: RuntimeOptions = {}): Runtime {
  const globalObj = globalThis as any;
  let runtime = globalObj[RUNTIME_SYMBOL] as RuntimeImpl | undefined;
  if (!runtime) {
    runtime = new RuntimeImpl(pi);
    globalObj[RUNTIME_SYMBOL] = runtime;
  }

  runtime.enableFeatures(pi, options);
  return runtime;
}
