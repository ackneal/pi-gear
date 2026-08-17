import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TProperties } from "typebox";
import { Value } from "typebox/value";
import { PlanWidgetController, type PlanUiChange } from "../../ui/plan/controller.ts";
import { renderCall, renderResult } from "../../ui/plan/renderer.ts";
import { cloneTaskState, isTaskStateSnapshot, nextTodoId, snapshotTaskState } from "./core.ts";
import { TASK_STATE_LIMITS, type TaskState, type TaskStateAction, type TaskStateDetails } from "./types.ts";

const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const ACTIONS = ["set_plan", "update_goal", "add_todo", "update_todo", "remove_todo", "add_constraint", "remove_constraint", "add_finding", "remove_finding", "show", "clear"] as const;
const STATUSES = ["pending", "in_progress", "done"] as const;
const status = () => Type.String({ enum: STATUSES });
const strict = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const TodoInput = strict({
  text: text(TASK_STATE_LIMITS.todoText),
  doneWhen: text(TASK_STATE_LIMITS.doneWhen),
  status: Type.Optional(status()),
});
const RuntimeStatus = Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("done")]);
const RuntimeTodoInput = strict({
  text: Type.String(),
  doneWhen: Type.String(),
  status: Type.Optional(RuntimeStatus),
});

/** Provider-facing schema is flat because some providers reject top-level unions. */
export const TaskStateParams = strict({
  action: Type.String({ enum: ACTIONS }),
  goal: Type.Optional(text(TASK_STATE_LIMITS.goal)),
  todos: Type.Optional(Type.Array(TodoInput, { minItems: 1, maxItems: TASK_STATE_LIMITS.todos })),
  todo: Type.Optional(TodoInput),
  id: Type.Optional(Type.Integer({ minimum: 1 })),
  text: Type.Optional(text(TASK_STATE_LIMITS.todoText)),
  doneWhen: Type.Optional(text(TASK_STATE_LIMITS.doneWhen)),
  status: Type.Optional(status()),
  constraint: Type.Optional(text(TASK_STATE_LIMITS.constraint)),
  finding: Type.Optional(text(TASK_STATE_LIMITS.finding)),
});

const RuntimeTaskStateParams = Type.Union([
  strict({ action: Type.Literal("set_plan"), goal: Type.String(), todos: Type.Array(RuntimeTodoInput) }),
  strict({ action: Type.Literal("update_goal"), goal: Type.String() }),
  strict({ action: Type.Literal("add_todo"), todo: RuntimeTodoInput }),
  strict({ action: Type.Literal("update_todo"), id: Type.Integer({ minimum: 1 }), text: Type.Optional(Type.String()), doneWhen: Type.Optional(Type.String()), status: Type.Optional(RuntimeStatus) }),
  strict({ action: Type.Literal("remove_todo"), id: Type.Integer({ minimum: 1 }) }),
  strict({ action: Type.Literal("add_constraint"), constraint: Type.String() }),
  strict({ action: Type.Literal("remove_constraint"), constraint: Type.String() }),
  strict({ action: Type.Literal("add_finding"), finding: Type.String() }),
  strict({ action: Type.Literal("remove_finding"), finding: Type.String() }),
  strict({ action: Type.Literal("show") }),
  strict({ action: Type.Literal("clear") }),
]);

export type TaskStateParams = Static<typeof RuntimeTaskStateParams>;

export const TASK_STATE_ENTRY = "pi-gear.task-state";

const actions: Record<TaskStateAction, string> = {
  set_plan: "Plan set",
  update_goal: "Goal updated",
  add_todo: "Todo added",
  update_todo: "Todo updated",
  remove_todo: "Todo removed",
  add_constraint: "Constraint added",
  remove_constraint: "Constraint removed",
  add_finding: "Finding added",
  remove_finding: "Finding removed",
  show: "Plan",
  clear: "Plan cleared",
};

export function isTaskStateDetails(value: unknown): value is TaskStateDetails {
  return typeof value === "object" && value !== null
    && (value as { tool?: unknown }).tool === "task_state"
    && typeof (value as { action?: unknown }).action === "string"
    && Object.hasOwn(actions, (value as { action: string }).action)
    && isTaskStateSnapshot(value);
}

export function formatTaskState(state: TaskState | undefined): string {
  if (state === undefined) return "Task state: empty.";

  return [
    `Goal: ${state.goal}`,
    `Todos: ${state.todos.map((todo) => `#${todo.id} [${todo.status}] ${todo.text} (done when: ${todo.doneWhen})`).join("; ")}`,
    `Constraints: ${state.constraints.length ? state.constraints.join("; ") : "none"}`,
    `Findings: ${state.findings.length ? state.findings.join("; ") : "none"}`,
  ].join("\n");
}

export interface TaskStateHandle {
  /** Latest state, including a completed plan until agent settlement. */
  getState(): TaskState | undefined;
  /** State eligible for a subsequent agent run's prompt snapshot. */
  getActiveState(): TaskState | undefined;
}

export function setupTaskState(pi: ExtensionAPI): TaskStateHandle {
  let state: TaskState | undefined;
  const widget = new PlanWidgetController();
  const reconstruct = (ctx: ExtensionContext): void => {
    state = undefined;
    const branch = ctx.sessionManager.getBranch();

    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (entry?.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "task_state") {
        if (isTaskStateDetails(entry.message.details)) {
          state = entry.message.details.state === null
            ? undefined
            : cloneTaskState(entry.message.details.state);
        }
        break;
      }
      if (entry?.type === "custom" && entry.customType === TASK_STATE_ENTRY) {
        if (isTaskStateSnapshot(entry.data)) {
          state = entry.data.state === null ? undefined : cloneTaskState(entry.data.state);
        }
        break;
      }
    }

    widget.reconstruct(ctx, state);
  };

  const persistIfChanged = (ctx: ExtensionContext): void => {
    const current = snapshotTaskState(state);
    const latest = newestTaskStateEntry(ctx.sessionManager.getBranch());

    if (!sameSnapshot(current, latest)) {
      pi.appendEntry(TASK_STATE_ENTRY, current);
    }
  };

  pi.on("session_start", (_event, ctx) => reconstruct(ctx));
  pi.on("session_tree", (_event, ctx) => reconstruct(ctx));
  pi.on("session_compact", (_event, ctx) => {
    // Compaction may remove the latest task_state tool result from the branch;
    // persist the in-memory snapshot in a non-context entry for reconstruction.
    persistIfChanged(ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (state === undefined || !isComplete(state)) return;

    state = undefined;
    persistIfChanged(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => widget.shutdown(ctx));
  pi.registerTool({
    name: "task_state",
    label: "Plan",
    description: "Maintain the main task's active goal, outcome todos, constraints, and decision-relevant findings. Replanning preserves knowledge; clear starts a new task.",
    parameters: TaskStateParams,
    renderCall,
    renderResult,
    renderShell: "self",
    async execute(_id, rawParams, _signal, _onUpdate, ctx) {
      const params = parseTaskStateParams(rawParams);
      if (params === undefined) return invalidResult(rawParams, state);

      const previous = cloneTaskState(state);
      const result = applyAction(state, params);
      state = result.state;

      const details: TaskStateDetails = {
        tool: "task_state",
        action: params.action,
        params: structuredClone(params),
        ...snapshotTaskState(state),
      };
      const rendering = formatTaskState(state);

      if (result.error === undefined) {
        widget.update(ctx, previous, state, planUiChange(params));
      }

      return result.error === undefined
        ? { content: [{ type: "text", text: `${actions[params.action]}\n${rendering}` }], details }
        : { content: [{ type: "text", text: `${result.error}\n${rendering}` }], details, isError: true };
    },
  });
  return {
    getState: () => cloneTaskState(state),
    getActiveState: () => state === undefined || isComplete(state) ? undefined : cloneTaskState(state),
  };
}

function planUiChange(params: TaskStateParams): PlanUiChange {
  if (params.action !== "update_todo") return { action: params.action };
  return { action: params.action, ...(params.status === undefined ? {} : { statusChanged: true }), ...(params.text === undefined ? {} : { textChanged: true }), ...(params.doneWhen === undefined ? {} : { doneWhenChanged: true }) };
}

type SetPlanParams = Extract<TaskStateParams, { action: "set_plan" }>;
type UpdateGoalParams = Extract<TaskStateParams, { action: "update_goal" }>;
type AddTodoParams = Extract<TaskStateParams, { action: "add_todo" }>;
type UpdateTodoParams = Extract<TaskStateParams, { action: "update_todo" }>;
type RemoveTodoParams = Extract<TaskStateParams, { action: "remove_todo" }>;
type CollectionParams = Extract<
  TaskStateParams,
  { action: "add_constraint" | "remove_constraint" | "add_finding" | "remove_finding" }
>;

type ActionResult = { state: TaskState | undefined; error?: string };

export function applyAction(current: TaskState | undefined, params: TaskStateParams): ActionResult {
  if (params.action === "set_plan") return applySetPlan(current, params);
  if (params.action === "show") return { state: current };
  if (params.action === "clear") return { state: undefined };
  if (current === undefined) return { state: current, error: "Set a plan before changing task state." };

  const state = cloneTaskState(current)!;
  if (params.action === "update_goal") return applyUpdateGoal(current, state, params);
  if (params.action === "add_todo") return applyAddTodo(current, state, params);
  if (params.action === "update_todo") return applyUpdateTodo(current, state, params);
  if (params.action === "remove_todo") return applyRemoveTodo(current, state, params);
  return applyCollection(current, state, params);
}

function invalidResult(rawParams: unknown, state: TaskState | undefined) {
  const raw = typeof rawParams === "object" && rawParams !== null && !Array.isArray(rawParams)
    ? rawParams as Record<string, unknown>
    : undefined;
  const action = typeof raw?.action === "string" && Object.hasOwn(actions, raw.action)
    ? raw.action as TaskStateAction
    : "show";
  const details: TaskStateDetails = {
    tool: "task_state",
    action,
    params: raw === undefined ? {} : structuredClone(raw),
    ...snapshotTaskState(state),
  };
  return { content: [{ type: "text" as const, text: `Invalid task_state parameters.\n${formatTaskState(state)}` }], details, isError: true };
}

function parseTaskStateParams(value: unknown): TaskStateParams | undefined {
  return Value.Check(RuntimeTaskStateParams, value) ? value : undefined;
}

function applySetPlan(current: TaskState | undefined, params: SetPlanParams): ActionResult {
  if (params.todos.length < 1 || params.todos.length > TASK_STATE_LIMITS.todos) {
    return { state: current, error: "A task state must have 1–10 todos." };
  }

  const invalidTodo = params.todos.some((todo) =>
    !validText(todo.text, TASK_STATE_LIMITS.todoText)
    || !validText(todo.doneWhen, TASK_STATE_LIMITS.doneWhen),
  );
  if (!validText(params.goal, TASK_STATE_LIMITS.goal) || invalidTodo) {
    return { state: current, error: "Text values cannot be blank or exceed their limit." };
  }

  return {
    state: {
      goal: params.goal,
      todos: params.todos.map((todo, index) => ({
        id: index + 1,
        text: todo.text,
        doneWhen: todo.doneWhen,
        status: todo.status ?? "pending",
      })),
      constraints: current === undefined || isComplete(current) ? [] : [...current.constraints],
      findings: current === undefined || isComplete(current) ? [] : [...current.findings],
    },
  };
}

function applyUpdateGoal(current: TaskState, state: TaskState, params: UpdateGoalParams): ActionResult {
  if (!validText(params.goal, TASK_STATE_LIMITS.goal)) {
    return { state: current, error: "Text values cannot be blank or exceed their limit." };
  }
  return { state: { ...state, goal: params.goal } };
}

function applyAddTodo(current: TaskState, state: TaskState, params: AddTodoParams): ActionResult {
  if (!validText(params.todo.text, TASK_STATE_LIMITS.todoText) || !validText(params.todo.doneWhen, TASK_STATE_LIMITS.doneWhen)) {
    return { state: current, error: "Text values cannot be blank or exceed their limit." };
  }
  if (state.todos.length === TASK_STATE_LIMITS.todos) {
    return { state: current, error: "A task state can have at most 10 todos." };
  }

  state.todos.push({
    id: nextTodoId(state),
    text: params.todo.text,
    doneWhen: params.todo.doneWhen,
    status: params.todo.status ?? "pending",
  });
  return { state };
}

function applyUpdateTodo(current: TaskState, state: TaskState, params: UpdateTodoParams): ActionResult {
  if (params.text === undefined && params.doneWhen === undefined && params.status === undefined) {
    return { state: current, error: "Provide text, doneWhen, or status to update a todo." };
  }
  if (
    (params.text !== undefined && !validText(params.text, TASK_STATE_LIMITS.todoText))
    || (params.doneWhen !== undefined && !validText(params.doneWhen, TASK_STATE_LIMITS.doneWhen))
  ) {
    return { state: current, error: "Text values cannot be blank or exceed their limit." };
  }

  const todo = state.todos.find((item) => item.id === params.id);
  if (todo === undefined) return { state: current, error: `Todo #${params.id} not found.` };
  if (params.text !== undefined) todo.text = params.text;
  if (params.doneWhen !== undefined) todo.doneWhen = params.doneWhen;
  if (params.status !== undefined) todo.status = params.status;
  return { state };
}

function applyRemoveTodo(current: TaskState, state: TaskState, params: RemoveTodoParams): ActionResult {
  const index = state.todos.findIndex((todo) => todo.id === params.id);
  if (index < 0) return { state: current, error: `Todo #${params.id} not found.` };
  if (state.todos.length === 1) {
    return { state: current, error: "A task state must have at least 1 todo; clear it instead." };
  }

  state.todos.splice(index, 1);
  return { state };
}

function applyCollection(current: TaskState, state: TaskState, params: CollectionParams): ActionResult {
  const constraintAction = params.action === "add_constraint" || params.action === "remove_constraint";
  const field = constraintAction ? "constraints" : "findings";
  const value = constraintAction ? params.constraint : params.finding;
  const limit = field === "constraints" ? TASK_STATE_LIMITS.constraint : TASK_STATE_LIMITS.finding;

  if (!validText(value, limit)) {
    return { state: current, error: "Text values cannot be blank or exceed their limit." };
  }

  const values = state[field];
  const adding = params.action.startsWith("add_");
  const index = values.indexOf(value);
  const label = field === "constraints" ? "Constraint" : "Finding";

  if (adding && index >= 0) return { state: current, error: `${label} already exists.` };
  if (adding && values.length === TASK_STATE_LIMITS[field]) {
    return { state: current, error: `A task state can have at most ${TASK_STATE_LIMITS[field]} ${field}.` };
  }
  if (!adding && index < 0) return { state: current, error: `${label} not found.` };

  if (adding) values.push(value);
  else values.splice(index, 1);
  return { state };
}

function validText(value: string, maxLength: number): boolean {
  return value.trim().length > 0 && value.length <= maxLength;
}

function isComplete(state: TaskState): boolean {
  return state.todos.every((todo) => todo.status === "done");
}

function newestTaskStateEntry(branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>) {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type === "custom" && entry.customType === TASK_STATE_ENTRY) return isTaskStateSnapshot(entry.data) ? entry.data : undefined;
  }
  return undefined;
}

function sameSnapshot(left: ReturnType<typeof snapshotTaskState>, right: ReturnType<typeof snapshotTaskState> | undefined): boolean {
  if (right === undefined || left.version !== right.version || left.state === null || right.state === null) return left.state === right?.state;
  const leftState = left.state;
  const rightState = right.state;
  return leftState.goal === rightState.goal
    && sameArray(leftState.todos, rightState.todos, (a, b) => a.id === b.id && a.text === b.text && a.doneWhen === b.doneWhen && a.status === b.status)
    && sameArray(leftState.constraints, rightState.constraints, (a, b) => a === b)
    && sameArray(leftState.findings, rightState.findings, (a, b) => a === b);
}

function sameArray<T>(left: T[], right: T[], equal: (left: T, right: T) => boolean): boolean {
  return left.length === right.length && left.every((value, index) => right[index] !== undefined && equal(value, right[index]));
}

export * from "./core.ts";
export * from "./types.ts";
