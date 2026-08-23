export const TASK_STATE_VERSION = 2 as const;

export const TASK_STATE_LIMITS = {
  goal: 500,
  stepOutcome: 300,
  doneWhen: 300,
  steps: 10,
  constraints: 10,
  constraint: 300,
  findings: 10,
  finding: 500,
} as const;

export type StepStatus = "pending" | "in_progress" | "done";

export interface PlanStep {
  id: number;
  outcome: string;
  doneWhen: string;
  status: StepStatus;
}

export interface TaskState {
  goal: string;
  steps: PlanStep[];
  constraints: string[];
  findings: string[];
}

export interface TaskStateSnapshot {
  version: typeof TASK_STATE_VERSION;
  state: TaskState | null;
}

export type TaskStateAction =
  | "set_plan"
  | "add_step"
  | "revise_step"
  | "remove_step"
  | "start_step"
  | "complete_step"
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
