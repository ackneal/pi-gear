import { TASK_STATE_LIMITS, TASK_STATE_VERSION, type TaskState, type TaskStateSnapshot, type Todo } from "./types.ts";

export function cloneTaskState(state: TaskState | undefined): TaskState | undefined {
  if (state === undefined) return undefined;

  return {
    goal: state.goal,
    todos: state.todos.map((todo) => ({ ...todo })),
    constraints: [...state.constraints],
    findings: [...state.findings],
  };
}

export function snapshotTaskState(state: TaskState | undefined): TaskStateSnapshot {
  return {
    version: TASK_STATE_VERSION,
    state: cloneTaskState(state) ?? null,
  };
}

export function isTaskStateSnapshot(value: unknown): value is TaskStateSnapshot {
  return isRecord(value)
    && Object.hasOwn(value, "state")
    && value.version === TASK_STATE_VERSION
    && (value.state === null || isTaskState(value.state));
}

export function isTaskState(value: unknown): value is TaskState {
  if (
    !isRecord(value)
    || !nonblank(value.goal)
    || !Array.isArray(value.todos)
    || value.goal.length > TASK_STATE_LIMITS.goal
    || value.todos.length < 1
    || value.todos.length > TASK_STATE_LIMITS.todos
    || !Array.isArray(value.constraints)
    || value.constraints.length > TASK_STATE_LIMITS.constraints
    || !value.constraints.every((item) => nonblank(item) && item.length <= TASK_STATE_LIMITS.constraint)
    || !Array.isArray(value.findings)
    || value.findings.length > TASK_STATE_LIMITS.findings
    || !value.findings.every((item) => nonblank(item) && item.length <= TASK_STATE_LIMITS.finding)
    || !value.todos.every(isTodo)
  ) {
    return false;
  }

  const ids = new Set(value.todos.map((todo) => todo.id));
  return ids.size === value.todos.length;
}

export function nextTodoId(state: TaskState): number {
  return state.todos.reduce((maximum, todo) => Math.max(maximum, todo.id), 0) + 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTodo(value: unknown): value is Todo {
  return isRecord(value)
    && Number.isSafeInteger(value.id)
    && (value.id as number) > 0
    && nonblank(value.text)
    && value.text.length <= TASK_STATE_LIMITS.todoText
    && nonblank(value.doneWhen)
    && value.doneWhen.length <= TASK_STATE_LIMITS.doneWhen
    && (value.status === "pending" || value.status === "in_progress" || value.status === "done");
}
