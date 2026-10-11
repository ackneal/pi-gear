import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TProperties } from "typebox";
import { Value } from "typebox/value";
import { PlanWidgetController, type PlanUiChange } from "../../ui/plan/controller.ts";
import { renderCall, renderResult } from "../../ui/plan/renderer.ts";
import { cloneTaskState, isTaskStateSnapshot, nextPlanStepId, snapshotTaskState } from "./core.ts";
import {
  TASK_STATE_LIMITS,
  type PlanStep,
  type StepStatus,
  type TaskState,
  type TaskStateAction,
  type TaskStateDetails,
} from "./types.ts";

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
const ACTIONS = [
  "set_plan",
  "advance_step",
  "update_step",
  "add_step",
  "add_finding",
  "show",
  "clear",
] as const;

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

const StepStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("done"),
]);

/** Provider-facing schema is flat because some providers reject top-level unions. */
export const TaskStateParams = strict({
  action: Type.String({
    enum: ACTIONS,
    description: "Action to perform: advance_step (progress active step and start next), update_step (modify or reopen a step), set_plan, add_step, add_finding, show, clear.",
  }),
  goal: Type.Optional(text(TASK_STATE_LIMITS.goal)),
  steps: Type.Optional(Type.Array(PlanStepInput, { minItems: 1, maxItems: TASK_STATE_LIMITS.steps })),
  constraints: Type.Optional(Type.Array(text(TASK_STATE_LIMITS.constraint), {
    maxItems: TASK_STATE_LIMITS.constraints,
    description: "Replaces constraints on set_plan; omitted constraints and existing findings are preserved. Use clear for a fresh task.",
  })),
  id: Type.Optional(Type.Integer({
    minimum: 1,
    description: "Step ID to complete (for advance_step) or update (for update_step). Defaults to the active in-progress step for advance_step; only needed if multiple steps are in progress.",
  })),
  nextId: Type.Optional(Type.Integer({
    minimum: 1,
    description: "Specific pending step ID to start (for advance_step). Defaults to the first pending step in plan order, even when other steps remain in progress. Use for non-linear workflows.",
  })),
  outcome: Type.Optional(outcome()),
  doneWhen: Type.Optional(doneWhen()),
  status: Type.Optional(StepStatusSchema),
  finding: Type.Optional(text(TASK_STATE_LIMITS.finding)),
});

const RuntimeTaskStateParams = Type.Union([
  strict({
    action: Type.Literal("set_plan"),
    goal: Type.String(),
    steps: Type.Array(RuntimePlanStepInput),
    constraints: Type.Optional(Type.Array(Type.String())),
  }),
  strict({
    action: Type.Literal("advance_step"),
    id: Type.Optional(Type.Integer({ minimum: 1 })),
    nextId: Type.Optional(Type.Integer({ minimum: 1 })),
    finding: Type.Optional(Type.String()),
  }),
  strict({
    action: Type.Literal("update_step"),
    id: Type.Integer({ minimum: 1 }),
    outcome: Type.Optional(Type.String()),
    doneWhen: Type.Optional(Type.String()),
    status: Type.Optional(StepStatusSchema),
  }),
  strict({
    action: Type.Literal("add_step"),
    outcome: Type.String(),
    doneWhen: Type.String(),
  }),
  strict({
    action: Type.Literal("add_finding"),
    finding: Type.String(),
  }),
  strict({ action: Type.Literal("show") }),
  strict({ action: Type.Literal("clear") }),
]);

export type TaskStateParams = Static<typeof RuntimeTaskStateParams>;

export const TASK_STATE_ENTRY = "pi-gear.task-state";

export function isTaskStateDetails(value: unknown): value is TaskStateDetails {
  return typeof value === "object" && value !== null
    && (value as { tool?: unknown }).tool === "task_state"
    && typeof (value as { action?: unknown }).action === "string"
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
    description: "Maintain the task plan: goal, steps, constraints, and findings. Use set_plan to initialize or replace goal and steps while preserving findings and omitted constraints; clear first for a fresh task. Use advance_step to complete an active step and start the first pending step in plan order, preserving other active steps (id required when multiple are active; nextId selects a specific pending step). Use update_step to modify or reopen a step, add_step to append a pending step, add_finding to record facts, show to view, clear to reset.",
    parameters: TaskStateParams,
    renderCall,
    renderResult,
    renderShell: "self",
    async execute(_id, rawParams, _signal, _onUpdate, ctx) {
      const params = parseTaskStateParams(rawParams);
      if (params === undefined) {
        const reason = describeParamError(rawParams);
        return invalidResult(rawParams, state, reason);
      }

      const previous = cloneTaskState(state);
      const result = applyAction(state, params);
      state = result.state;

      const details: TaskStateDetails = {
        tool: "task_state",
        action: params.action,
        params: structuredClone(params),
        ...snapshotTaskState(state),
      };

      if (result.error !== undefined) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          details,
          isError: true,
        };
      }

      widget.update(ctx, previous, state, { action: params.action });

      return {
        content: [{ type: "text" as const, text: formatSuccess(params.action, result.feedback!, state) }],
        details,
      };
    },
  });
}

type SetPlanParams = Extract<TaskStateParams, { action: "set_plan" }>;
type AdvanceStepParams = Extract<TaskStateParams, { action: "advance_step" }>;
type UpdateStepParams = Extract<TaskStateParams, { action: "update_step" }>;
type AddStepParams = Extract<TaskStateParams, { action: "add_step" }>;
type AddFindingParams = Extract<TaskStateParams, { action: "add_finding" }>;

type ActionResult = {
  state: TaskState | undefined;
  feedback?: string;
  error?: string;
};

export function applyAction(current: TaskState | undefined, params: TaskStateParams): ActionResult {
  if (parseTaskStateParams(params) === undefined) {
    const reason = describeParamError(params);
    return { state: current, error: reason ? `Invalid task_state parameters: ${reason}` : "Invalid task_state parameters." };
  }

  if (params.action === "set_plan") {
    return applySetPlan(current, params);
  }

  if (params.action === "show") {
    return { state: current, feedback: current ? "Plan" : "Task state is empty." };
  }

  if (params.action === "clear") {
    return { state: undefined, feedback: "Task state cleared." };
  }

  if (current === undefined) {
    return { state: undefined, error: "Task state is empty. Call set_plan first." };
  }

  const state = cloneTaskState(current);

  switch (params.action) {
    case "advance_step":
      return applyAdvanceStep(current, state!, params);
    case "update_step":
      return applyUpdateStep(current, state!, params);
    case "add_step":
      return applyAddStep(current, state!, params);
    case "add_finding":
      return applyAddFinding(current, state!, params);
  }
}

function invalidResult(
  raw: unknown,
  state: TaskState | undefined,
  reason: string | undefined,
): { content: [{ type: "text"; text: string }]; details: TaskStateDetails; isError: true } {
  const params = typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : undefined;
  const action = isTaskStateAction(params?.action) ? params.action : "show";
  const details: TaskStateDetails = {
    tool: "task_state",
    action,
    params: raw === undefined || raw === null ? {} : structuredClone(raw) as Record<string, unknown>,
    ...snapshotTaskState(state),
  };
  const text = reason
    ? `Invalid task_state parameters: ${reason}`
    : "Invalid task_state parameters.";
  return { content: [{ type: "text" as const, text }], details, isError: true };
}

function describeParamError(rawParams: unknown): string | undefined {
  if (typeof rawParams !== "object" || rawParams === null || Array.isArray(rawParams)) {
    return "expected an object with an 'action' property.";
  }

  const raw = rawParams as Record<string, unknown>;
  const action = raw.action;
  if (typeof action !== "string" || !isTaskStateAction(action)) {
    return `unknown action '${String(action)}'. Valid actions are: ${ACTIONS.join(", ")}.`;
  }

  if (action === "set_plan") {
    if (typeof raw.goal !== "string" || !Array.isArray(raw.steps)) {
      return "set_plan requires 'goal' (string) and 'steps' (array of { outcome, doneWhen }).";
    }
  }

  if (action === "add_step") {
    if (typeof raw.outcome !== "string" || typeof raw.doneWhen !== "string") {
      return "add_step requires 'outcome' and 'doneWhen'.";
    }
  }

  if (action === "update_step") {
    if (typeof raw.id !== "number" || raw.id < 1 || !Number.isInteger(raw.id)) {
      return "update_step requires 'id' (integer >= 1).";
    }
    if (raw.outcome === undefined && raw.doneWhen === undefined && raw.status === undefined) {
      return "update_step requires at least one of 'outcome', 'doneWhen', or 'status'.";
    }
  }

  if (action === "advance_step") {
    if (raw.id !== undefined && (typeof raw.id !== "number" || raw.id < 1 || !Number.isInteger(raw.id))) {
      return "advance_step 'id' must be an integer >= 1.";
    }
    if (raw.nextId !== undefined && (typeof raw.nextId !== "number" || raw.nextId < 1 || !Number.isInteger(raw.nextId))) {
      return "advance_step 'nextId' must be an integer >= 1.";
    }
    if (raw.finding !== undefined && typeof raw.finding !== "string") {
      return "advance_step 'finding' must be a string.";
    }
  }

  if (action === "add_finding") {
    if (typeof raw.finding !== "string") {
      return "add_finding requires 'finding' (string).";
    }
  }

  return undefined;
}

function parseTaskStateParams(value: unknown): TaskStateParams | undefined {
  if (!Value.Check(RuntimeTaskStateParams, value)) return undefined;

  if (value.action === "update_step") {
    if (value.outcome === undefined && value.doneWhen === undefined && value.status === undefined) {
      return undefined;
    }
  }

  return value as TaskStateParams;
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

  if (params.constraints !== undefined) {
    if (params.constraints.length > TASK_STATE_LIMITS.constraints) {
      return { state: current, error: `A task state can have at most ${TASK_STATE_LIMITS.constraints} constraints.` };
    }
    const invalidConstraint = params.constraints.some((c) => !validText(c, TASK_STATE_LIMITS.constraint));
    if (invalidConstraint) {
      return { state: current, error: "Constraint text cannot be blank or exceed its limit." };
    }
  }

  const constraints = params.constraints !== undefined
    ? [...params.constraints]
    : [...(current?.constraints ?? [])];

  return {
    state: {
      goal: params.goal,
      steps: params.steps.map((step, index) => ({
        id: index + 1,
        outcome: step.outcome,
        doneWhen: step.doneWhen,
        status: "pending",
      })),
      constraints,
      findings: [...(current?.findings ?? [])],
    },
    feedback: "Plan set",
  };
}

function applyAddStep(current: TaskState, state: TaskState, params: AddStepParams): ActionResult {
  if (!validText(params.outcome, TASK_STATE_LIMITS.stepOutcome) || !validText(params.doneWhen, TASK_STATE_LIMITS.doneWhen)) {
    return { state: current, error: "Text values cannot be blank or exceed their limit." };
  }
  if (state.steps.length >= TASK_STATE_LIMITS.steps) {
    return { state: current, error: "A task state can have at most 10 steps." };
  }

  const step: PlanStep = {
    id: nextPlanStepId(state),
    outcome: params.outcome,
    doneWhen: params.doneWhen,
    status: "pending",
  };
  state.steps.push(step);
  return { state, feedback: formatStepFeedback(`Step #${step.id} added`, step) };
}

function applyUpdateStep(current: TaskState, state: TaskState, params: UpdateStepParams): ActionResult {
  if (
    (params.outcome !== undefined && !validText(params.outcome, TASK_STATE_LIMITS.stepOutcome))
    || (params.doneWhen !== undefined && !validText(params.doneWhen, TASK_STATE_LIMITS.doneWhen))
  ) {
    return { state: current, error: "Text values cannot be blank or exceed their limit." };
  }

  const step = state.steps.find((item) => item.id === params.id);
  if (step === undefined) return { state: current, error: `Step #${params.id} not found.` };

  if (params.outcome !== undefined) step.outcome = params.outcome;
  if (params.doneWhen !== undefined) step.doneWhen = params.doneWhen;
  if (params.status !== undefined) step.status = params.status;

  return { state, feedback: formatStepFeedback(`Step #${step.id} updated`, step) };
}

function applyAdvanceStep(current: TaskState, state: TaskState, params: AdvanceStepParams): ActionResult {
  const inProgress = state.steps.filter((item) => item.status === "in_progress");

  if (params.finding !== undefined && !validText(params.finding, TASK_STATE_LIMITS.finding)) {
    return { state: current, error: "Text values cannot be blank or exceed their limit." };
  }
  const isDuplicateFinding = params.finding !== undefined && state.findings.includes(params.finding);
  if (params.finding !== undefined && !isDuplicateFinding && state.findings.length >= TASK_STATE_LIMITS.findings) {
    return { state: current, error: `A task state can have at most ${TASK_STATE_LIMITS.findings} findings.` };
  }

  if (inProgress.length === 0 && params.id === undefined) {
    const nextStep = params.nextId !== undefined
      ? state.steps.find((item) => item.id === params.nextId)
      : state.steps.find((item) => item.status === "pending");
    if (params.nextId !== undefined && nextStep === undefined) {
      return { state: current, error: `Step #${params.nextId} not found.` };
    }
    if (params.nextId !== undefined && nextStep?.status !== "pending") {
      return { state: current, error: `Step #${params.nextId} is not pending.` };
    }
    if (nextStep === undefined) {
      return { state: current, error: "All steps are complete; no pending step to start." };
    }

    nextStep.status = "in_progress";
    if (params.finding !== undefined && !isDuplicateFinding) state.findings.push(params.finding);

    const feedback = [
      formatStepFeedback(`Step #${nextStep.id} in progress`, nextStep),
      ...(params.finding !== undefined && !isDuplicateFinding ? [`Finding added\n${params.finding}`] : []),
    ].join("\n");
    return { state, feedback };
  }

  const stepToComplete = params.id !== undefined
    ? state.steps.find((item) => item.id === params.id)
    : inProgress.length === 1 ? inProgress[0] : undefined;
  if (params.id !== undefined && stepToComplete === undefined) {
    return { state: current, error: `Step #${params.id} not found.` };
  }
  if (params.id !== undefined && stepToComplete?.status !== "in_progress") {
    return { state: current, error: `Step #${params.id} is not in progress.` };
  }
  if (params.id === undefined && inProgress.length > 1) {
    return { state: current, error: "Multiple steps are in progress; provide an id." };
  }

  const nextStep = params.nextId !== undefined
    ? state.steps.find((item) => item.id === params.nextId)
    : state.steps.find((item) => item.status === "pending");
  if (params.nextId !== undefined && nextStep === undefined) {
    return { state: current, error: `Step #${params.nextId} not found.` };
  }
  if (params.nextId !== undefined && nextStep?.status !== "pending") {
    return { state: current, error: `Step #${params.nextId} is not pending.` };
  }

  stepToComplete!.status = "done";
  if (nextStep !== undefined) nextStep.status = "in_progress";
  if (params.finding !== undefined && !isDuplicateFinding) state.findings.push(params.finding);

  const feedback = [
    `Step #${stepToComplete!.id} complete`,
    ...(params.finding !== undefined && !isDuplicateFinding ? [`Finding added\n${params.finding}`] : []),
    ...(nextStep !== undefined ? [formatStepFeedback(`Step #${nextStep.id} in progress`, nextStep)] : []),
  ].join("\n");
  return { state, feedback };
}

function applyAddFinding(current: TaskState, state: TaskState, params: AddFindingParams): ActionResult {
  if (!validText(params.finding, TASK_STATE_LIMITS.finding)) {
    return { state: current, error: "Text values cannot be blank or exceed their limit." };
  }
  if (state.findings.includes(params.finding)) {
    return { state: current, feedback: `Finding already recorded\n${params.finding}` };
  }
  if (state.findings.length >= TASK_STATE_LIMITS.findings) {
    return { state: current, error: `A task state can have at most ${TASK_STATE_LIMITS.findings} findings.` };
  }
  state.findings.push(params.finding);
  return { state, feedback: `Finding added\n${params.finding}` };
}

function formatSuccess(action: TaskStateAction, feedback: string, state: TaskState | undefined): string {
  if (state === undefined) return feedback;

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
