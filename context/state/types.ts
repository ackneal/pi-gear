export const TASK_STATE_VERSION = 1 as const;

export const TASK_STATE_LIMITS = {
  goal: 500,
  todoText: 300,
  doneWhen: 300,
  todos: 7,
  constraints: 10,
  constraint: 300,
  findings: 10,
  finding: 500,
} as const;

export type TodoStatus = "pending" | "in_progress" | "done";

export interface Todo {
  id: number;
  text: string;
  doneWhen: string;
  status: TodoStatus;
}

export interface TaskState {
  goal: string;
  todos: Todo[];
  constraints: string[];
  findings: string[];
}

export interface TaskStateSnapshot {
  version: typeof TASK_STATE_VERSION;
  state: TaskState | null;
}

export type TaskStateAction =
  | "set_plan"
  | "update_goal"
  | "add_todo"
  | "update_todo"
  | "remove_todo"
  | "add_constraint"
  | "remove_constraint"
  | "add_finding"
  | "remove_finding"
  | "show"
  | "clear";

export interface TaskStateDetails extends TaskStateSnapshot {
  tool: "task_state";
  action: TaskStateAction;
  params: Record<string, unknown>;
}
