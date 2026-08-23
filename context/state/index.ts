import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TProperties } from "typebox";
import { Value } from "typebox/value";
import { PlanWidgetController, type PlanUiChange } from "../../ui/plan/controller.ts";
import { renderCall, renderResult } from "../../ui/plan/renderer.ts";
import { cloneTaskState, isTaskStateSnapshot, nextPlanStepId, snapshotTaskState } from "./core.ts";
import { TASK_STATE_LIMITS, type PlanStep, type TaskState, type TaskStateAction, type TaskStateDetails } from "./types.ts";

const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const outcome = () => Type.String({
  minLength: 1,
  maxLength: TASK_STATE_LIMITS.stepOutcome,
  description: "A coherent result, not an individual edit or command.",
});
const doneWhen = () => Type.String({
  minLength: 1,
  maxLength: TASK_STATE_LIMITS.doneWhen,
  description: "Observable completion condition.",
});
const ACTIONS = ["set_plan", "add_step", "revise_step", "remove_step", "start_step", "complete_step", "add_constraint", "remove_constraint", "add_finding", "remove_finding", "show", "clear"] as const;
const strict = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const PlanStepInput = strict({
  outcome: outcome(),
  doneWhen: doneWhen(),
});
const RuntimePlanStepInput = strict({
  outcome: Type.String(),
  doneWhen: Type.String(),
});

/** Provider-facing schema is flat because some providers reject top-level unions. */
export const TaskStateParams = strict({
  action: Type.String({ enum: ACTIONS }),
  goal: Type.Optional(text(TASK_STATE_LIMITS.goal)),
  steps: Type.Optional(Type.Array(PlanStepInput, { minItems: 1, maxItems: TASK_STATE_LIMITS.steps })),
  step: Type.Optional(PlanStepInput),
  id: Type.Optional(Type.Integer({ minimum: 1 })),
  outcome: Type.Optional(outcome()),
  doneWhen: Type.Optional(doneWhen()),
  constraint: Type.Optional(text(TASK_STATE_LIMITS.constraint)),
  finding: Type.Optional(text(TASK_STATE_LIMITS.finding)),
});

const RuntimeTaskStateParams = Type.Union([
  strict({ action: Type.Literal("set_plan"), goal: Type.String(), steps: Type.Array(RuntimePlanStepInput) }),
  strict({ action: Type.Literal("add_step"), step: RuntimePlanStepInput }),
  strict({ action: Type.Literal("revise_step"), id: Type.Integer({ minimum: 1 }), outcome: Type.Optional(Type.String()), doneWhen: Type.Optional(Type.String()) }),
  strict({ action: Type.Literal("remove_step"), id: Type.Integer({ minimum: 1 }) }),
  strict({ action: Type.Literal("start_step"), id: Type.Integer({ minimum: 1 }) }),
  strict({ action: Type.Literal("complete_step"), id: Type.Integer({ minimum: 1 }) }),
  strict({ action: Type.Literal("add_constraint"), constraint: Type.String() }),
  strict({ action: Type.Literal("remove_constraint"), constraint: Type.String() }),
  strict({ action: Type.Literal("add_finding"), finding: Type.String() }),
  strict({ action: Type.Literal("remove_finding"), finding: Type.String() }),
  strict({ action: Type.Literal("show") }),
  strict({ action: Type.Literal("clear") }),
]);

export type TaskStateParams = Static<typeof RuntimeTaskStateParams>;

export const TASK_STATE_ENTRY = "pi-gear.task-state";

export function isTaskStateDetails(value: unknown): value is TaskStateDetails {
  return typeof value === "object" && value !== null
    && (value as { tool?: unknown }).tool === "task_state"
    && isTaskStateAction((value as { action?: unknown }).action)
    && isTaskStateSnapshot(value);
}

export function formatTaskState(state: TaskState | undefined): string {
  if (state === undefined) return "Task state: empty.";

  return [
    `Goal: ${state.goal}`,
    `Steps: ${state.steps.map((step) => `#${step.id} [${step.status}] ${step.outcome} (done when: ${step.doneWhen})`).join("; ")}`,
    `Constraints: ${state.constraints.length ? state.constraints.join("; ") : "none"}`,
    `Findings: ${state.findings.length ? state.findings.join("; ") : "none"}`,
  ].join("\n");
}

export function setupTaskState(pi: ExtensionAPI): void {
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
    description: "Maintain the current task's working plan: goal, outcome steps, constraints, and decision-relevant findings. Clear abandons or resets the active state.",
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

      if (result.error === undefined) {
        widget.update(ctx, previous, state, planUiChange(params));
      }

      return result.error === undefined
        ? { content: [{ type: "text", text: formatSuccess(params.action, result.feedback, state) }], details }
        : { content: [{ type: "text", text: result.error }], details, isError: true };
    },
  });
}

function planUiChange(params: TaskStateParams): PlanUiChange {
  return { action: params.action };
}

type SetPlanParams = Extract<TaskStateParams, { action: "set_plan" }>;
type AddStepParams = Extract<TaskStateParams, { action: "add_step" }>;
type ReviseStepParams = Extract<TaskStateParams, { action: "revise_step" }>;
type RemoveStepParams = Extract<TaskStateParams, { action: "remove_step" }>;
type StartStepParams = Extract<TaskStateParams, { action: "start_step" }>;
type CompleteStepParams = Extract<TaskStateParams, { action: "complete_step" }>;
type CollectionParams = Extract<
  TaskStateParams,
  { action: "add_constraint" | "remove_constraint" | "add_finding" | "remove_finding" }
>;

type ActionResult =
  | { state: TaskState | undefined; feedback: string; error?: undefined }
  | { state: TaskState | undefined; feedback?: undefined; error: string };

export function applyAction(current: TaskState | undefined, params: TaskStateParams): ActionResult {
  if (params.action === "set_plan") return applySetPlan(current, params);
  if (params.action === "show") return { state: current, feedback: "Plan" };
  if (params.action === "clear") return { state: undefined, feedback: "Plan cleared" };
  if (current === undefined) return { state: current, error: "Set a plan before changing task state." };

  const state = cloneTaskState(current)!;
  if (params.action === "add_step") return applyAddStep(current, state, params);
  if (params.action === "revise_step") return applyReviseStep(current, state, params);
  if (params.action === "remove_step") return applyRemoveStep(current, state, params);
  if (params.action === "start_step") return applyStartStep(current, state, params);
  if (params.action === "complete_step") return applyCompleteStep(current, state, params);
  return applyCollection(current, state, params);
}

function invalidResult(rawParams: unknown, state: TaskState | undefined) {
  const raw = typeof rawParams === "object" && rawParams !== null && !Array.isArray(rawParams)
    ? rawParams as Record<string, unknown>
    : undefined;
  const action = isTaskStateAction(raw?.action) ? raw.action : "show";
  const details: TaskStateDetails = {
    tool: "task_state",
    action,
    params: raw === undefined ? {} : structuredClone(raw),
    ...snapshotTaskState(state),
  };
  return { content: [{ type: "text" as const, text: "Invalid task_state parameters." }], details, isError: true };
}

function parseTaskStateParams(value: unknown): TaskStateParams | undefined {
  return Value.Check(RuntimeTaskStateParams, value) ? value : undefined;
}

function applySetPlan(current: TaskState | undefined, params: SetPlanParams): ActionResult {
  if (params.steps.length < 1 || params.steps.length > TASK_STATE_LIMITS.steps) {
    return { state: current, error: "A task state must have 1–10 steps." };
  }

  const invalidStep = params.steps.some((step) =>
    !validText(step.outcome, TASK_STATE_LIMITS.stepOutcome)
    || !validText(step.doneWhen, TASK_STATE_LIMITS.doneWhen),
  );
  if (!validText(params.goal, TASK_STATE_LIMITS.goal) || invalidStep) {
    return { state: current, error: "Text values cannot be blank or exceed their limit." };
  }

  return {
    state: {
      goal: params.goal,
      steps: params.steps.map((step, index) => ({
        id: index + 1,
        outcome: step.outcome,
        doneWhen: step.doneWhen,
        status: "pending",
      })),
      constraints: current === undefined || isComplete(current) ? [] : [...current.constraints],
      findings: current === undefined || isComplete(current) ? [] : [...current.findings],
    },
    feedback: "Plan set",
  };
}

function applyAddStep(current: TaskState, state: TaskState, params: AddStepParams): ActionResult {
  if (!validText(params.step.outcome, TASK_STATE_LIMITS.stepOutcome) || !validText(params.step.doneWhen, TASK_STATE_LIMITS.doneWhen)) {
    return { state: current, error: "Text values cannot be blank or exceed their limit." };
  }
  if (state.steps.length === TASK_STATE_LIMITS.steps) {
    return { state: current, error: "A task state can have at most 10 steps." };
  }

  const step: PlanStep = {
    id: nextPlanStepId(state),
    outcome: params.step.outcome,
    doneWhen: params.step.doneWhen,
    status: "pending",
  };
  state.steps.push(step);
  return { state, feedback: formatStepFeedback(`Step #${step.id} added`, step) };
}

function applyReviseStep(current: TaskState, state: TaskState, params: ReviseStepParams): ActionResult {
  if (params.outcome === undefined && params.doneWhen === undefined) {
    return { state: current, error: "Provide outcome or doneWhen to revise a step." };
  }
  if (
    (params.outcome !== undefined && !validText(params.outcome, TASK_STATE_LIMITS.stepOutcome))
    || (params.doneWhen !== undefined && !validText(params.doneWhen, TASK_STATE_LIMITS.doneWhen))
  ) {
    return { state: current, error: "Text values cannot be blank or exceed their limit." };
  }

  const step = state.steps.find((item) => item.id === params.id);
  if (step === undefined) return { state: current, error: `Step #${params.id} not found.` };
  if (step.status === "done") {
    return { state: current, error: `Step #${params.id} is complete; use start_step to reopen it before revising it.` };
  }

  if (params.outcome !== undefined) step.outcome = params.outcome;
  if (params.doneWhen !== undefined) step.doneWhen = params.doneWhen;
  return { state, feedback: formatStepFeedback(`Step #${step.id} revised`, step) };
}

function applyRemoveStep(current: TaskState, state: TaskState, params: RemoveStepParams): ActionResult {
  const index = state.steps.findIndex((step) => step.id === params.id);
  if (index < 0) return { state: current, error: `Step #${params.id} not found.` };
  if (state.steps.length === 1) {
    return { state: current, error: "A task state must have at least 1 step; clear it instead." };
  }

  state.steps.splice(index, 1);
  return { state, feedback: `Step #${params.id} removed` };
}

function applyStartStep(current: TaskState, state: TaskState, params: StartStepParams): ActionResult {
  const step = state.steps.find((item) => item.id === params.id);
  if (step === undefined) return { state: current, error: `Step #${params.id} not found.` };
  if (step.status === "in_progress") return { state: current, error: `Step #${params.id} is already in progress.` };

  const reopened = step.status === "done";
  step.status = "in_progress";
  return {
    state,
    feedback: formatStepFeedback(`Step #${step.id} ${reopened ? "reopened" : "in progress"}`, step),
  };
}

function applyCompleteStep(current: TaskState, state: TaskState, params: CompleteStepParams): ActionResult {
  const step = state.steps.find((item) => item.id === params.id);
  if (step === undefined) return { state: current, error: `Step #${params.id} not found.` };
  if (step.status === "pending") return { state: current, error: `Start step #${params.id} before completing it.` };
  if (step.status === "done") return { state: current, error: `Step #${params.id} is already complete.` };

  step.status = "done";
  return { state, feedback: `Step #${step.id} complete` };
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
  return { state, feedback: `${label} ${adding ? "added" : "removed"}\n${value}` };
}

function formatSuccess(action: TaskStateAction, feedback: string, state: TaskState | undefined): string {
  return action === "set_plan" || action === "show"
    ? `${feedback}\n${formatTaskState(state)}`
    : feedback;
}

function formatStepFeedback(title: string, step: PlanStep): string {
  return `${title}\nOutcome: ${step.outcome}\nDone when: ${step.doneWhen}`;
}

function isTaskStateAction(value: unknown): value is TaskStateAction {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
}

function validText(value: string, maxLength: number): boolean {
  return value.trim().length > 0 && value.length <= maxLength;
}

function isComplete(state: TaskState): boolean {
  return state.steps.every((step) => step.status === "done");
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
    && sameArray(leftState.steps, rightState.steps, (a, b) => a.id === b.id && a.outcome === b.outcome && a.doneWhen === b.doneWhen && a.status === b.status)
    && sameArray(leftState.constraints, rightState.constraints, (a, b) => a === b)
    && sameArray(leftState.findings, rightState.findings, (a, b) => a === b);
}

function sameArray<T>(left: T[], right: T[], equal: (left: T, right: T) => boolean): boolean {
  return left.length === right.length && left.every((value, index) => right[index] !== undefined && equal(value, right[index]));
}

export * from "./core.ts";
export * from "./types.ts";
