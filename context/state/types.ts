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
  | "advance_step"
  | "update_step"
  | "add_step"
  | "add_finding"
  | "show"
  | "clear";

export interface TaskStateDetails extends TaskStateSnapshot {
  tool: "task_state";
  action: TaskStateAction | string;
  params: Record<string, unknown>;
}
