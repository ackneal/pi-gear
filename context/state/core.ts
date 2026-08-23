import { TASK_STATE_LIMITS, TASK_STATE_VERSION, type PlanStep, type TaskState, type TaskStateSnapshot } from "./types.ts";

export function cloneTaskState(state: TaskState | undefined): TaskState | undefined {
  if (state === undefined) return undefined;

  return {
    goal: state.goal,
    steps: state.steps.map((step) => ({ ...step })),
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
    || !hasExactKeys(value, ["goal", "steps", "constraints", "findings"])
    || !nonblank(value.goal)
    || !Array.isArray(value.steps)
    || value.goal.length > TASK_STATE_LIMITS.goal
    || value.steps.length < 1
    || value.steps.length > TASK_STATE_LIMITS.steps
    || !Array.isArray(value.constraints)
    || value.constraints.length > TASK_STATE_LIMITS.constraints
    || !value.constraints.every((item) => nonblank(item) && item.length <= TASK_STATE_LIMITS.constraint)
    || !Array.isArray(value.findings)
    || value.findings.length > TASK_STATE_LIMITS.findings
    || !value.findings.every((item) => nonblank(item) && item.length <= TASK_STATE_LIMITS.finding)
    || !value.steps.every(isPlanStep)
  ) {
    return false;
  }

  const ids = new Set(value.steps.map((step) => step.id));
  return ids.size === value.steps.length;
}

export function nextPlanStepId(state: TaskState): number {
  return state.steps.reduce((maximum, step) => Math.max(maximum, step.id), 0) + 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isPlanStep(value: unknown): value is PlanStep {
  return isRecord(value)
    && hasExactKeys(value, ["id", "outcome", "doneWhen", "status"])
    && Number.isSafeInteger(value.id)
    && (value.id as number) > 0
    && nonblank(value.outcome)
    && value.outcome.length <= TASK_STATE_LIMITS.stepOutcome
    && nonblank(value.doneWhen)
    && value.doneWhen.length <= TASK_STATE_LIMITS.doneWhen
    && (value.status === "pending" || value.status === "in_progress" || value.status === "done");
}
