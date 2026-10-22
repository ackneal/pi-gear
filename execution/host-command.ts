import {
  createBashToolDefinition,
  ExtensionEditorComponent,
  type BashToolDetails,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { executionToolRenderers } from "../ui/tools/index.ts";
import { CONFIRMATION_TIMEOUT_MS, ConfirmationQueue } from "./confirmation-queue.ts";

export const REQUEST_COMMAND_TOOL_NAME = "request_command";

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;

export const requestCommandParameters = Type.Object(
  {
    command: Type.String({ description: "Shell command to execute after the user reviews and authorizes it." }),
    reason: Type.Optional(Type.String({ description: "What the command does and why user authorization is needed." })),
    timeout: Type.Optional(Type.Number({
      description: "Timeout in seconds (optional, no default timeout).",
      exclusiveMinimum: 0,
      maximum: MAX_TIMEOUT_SECONDS,
    })),
  },
  { additionalProperties: false },
);

export type RequestCommandInput = Static<typeof requestCommandParameters>;

export interface CommandDetails extends BashToolDetails {
  command: string;
  status: "Waiting approval" | "Running" | "Completed" | "Cancelled" | "Failed";
}

export interface HostCommandOptions {
  readonly confirmationQueue?: ConfirmationQueue;
  readonly createBashTool?: typeof createBashToolDefinition;
}

export function setupHostCommand(pi: ExtensionAPI, options: HostCommandOptions = {}): void {
  const ownsQueue = options.confirmationQueue === undefined;
  const confirmationQueue = options.confirmationQueue ?? new ConfirmationQueue();
  const createBashTool = options.createBashTool ?? createBashToolDefinition;
  const baseTool = createBashTool(process.cwd());
  const renderers = executionToolRenderers(baseTool, {
    label: "Command",
  });

  let session = new AbortController();
  const endSession = (): void => {
    session.abort();
    if (ownsQueue) confirmationQueue.reset();
  };
  pi.on("session_start", () => {
    endSession();
    session = new AbortController();
  });
  pi.on("session_shutdown", endSession);

  pi.registerTool<typeof requestCommandParameters, CommandDetails>({
    name: REQUEST_COMMAND_TOOL_NAME,
    label: "Command",
    description:
      "Request approval to run a shell command on the host. The user can approve, edit, or cancel; approved commands return execution output.",
    promptSnippet:
      "Request user authorization for shell commands instead of asking the user to run them manually.",
    promptGuidelines: [
      "Use request_command when a command requires user authorization. State why approval is needed; never bypass a user denial or policy restriction.",
    ],
    exposure: "model-only",
    parameters: requestCommandParameters,
    renderShell: "self",
    renderCall(args, theme, context) {
      if (context.executionStarted || !context.isPartial) return new Text("", 0, 0);
      return renderers.renderCall!(args, theme, context);
    },
    renderResult(result, options, theme, context) {
      const details = result.details;
      const status = !options.isPartial && context.isError
        ? details?.status === "Cancelled" ? "Cancelled" : "Failed"
        : details?.status ?? (options.isPartial ? "Running" : "Completed");
      const component = new Container();
      component.addChild(renderers.renderCall!(
        { ...context.args, command: details?.command ?? context.args.command },
        theme,
        {
          ...context,
          isPartial: options.isPartial,
          isError: status === "Failed" || status === "Cancelled",
          executionStarted: status !== "Waiting approval",
        },
      ));
      if (renderers.renderResult) component.addChild(renderers.renderResult(result, options, theme, { ...context, lastComponent: undefined }));
      return component;
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!ctx.hasUI) {
        throw new Error("Host command execution requires interactive UI confirmation.");
      }

      const cwd = ctx.cwd;
      const executionSignal = signal ? AbortSignal.any([signal, session.signal]) : session.signal;
      let command = params.command;
      const publish = (status: CommandDetails["status"]): void => {
        onUpdate?.({ content: [], details: { command, status } });
      };
      const checkAbort = (): void => {
        if (executionSignal.aborted) {
          publish("Cancelled");
          throw new Error("Command aborted before execution.");
        }
      };

      try {
        if (params.timeout !== undefined && (!Number.isFinite(params.timeout) || params.timeout <= 0 || params.timeout > MAX_TIMEOUT_SECONDS)) {
          throw new Error(`Invalid timeout: must be a finite number of seconds greater than 0 and at most ${MAX_TIMEOUT_SECONDS}`);
        }
        checkAbort();
        publish("Waiting approval");
        const reason = params.reason?.trim();
        const directory = cwd !== process.cwd() ? cwd : undefined;
        const promptTitle = ["Run command?", reason, [directory, `$ ${command}`].filter(Boolean).join("\n")].filter(Boolean).join("\n\n");

        const approved = await confirmationQueue.confirm(async (approvalSignal) => {
          checkAbort();
          const choice = await ctx.ui.select(
            promptTitle,
            ["Run", "Edit", "Cancel"],
            { timeout: CONFIRMATION_TIMEOUT_MS, signal: approvalSignal },
          );
          checkAbort();
          if (choice === "Run") return true;
          if (choice === "Edit") {
            // The RPC editor cannot be dismissed on abort or session changes.
            if (ctx.mode !== "tui") throw new Error("Editing commands requires terminal UI. Request a revised command instead.");
            const edited = await ctx.ui.custom<string | undefined>((tui, _theme, keybindings, done) => {
              const abort = (): void => done(undefined);
              const editor = new ExtensionEditorComponent(tui, keybindings, "Edit command", command, done, abort);
              const handleInput = editor.handleInput.bind(editor);
              editor.handleInput = (data) => {
                if (keybindings.matches(data, "app.editor.external")) {
                  ctx.ui.notify("External editors are unavailable during command approval.", "warning");
                  return;
                }
                handleInput(data);
              };
              approvalSignal.addEventListener("abort", abort, { once: true });
              if (approvalSignal.aborted) abort();
              return Object.assign(editor, {
                dispose: () => approvalSignal.removeEventListener("abort", abort),
              });
            });
            checkAbort();
            if (edited === undefined || edited.trim() === "") return false;
            command = edited.trim();
            return true;
          }
          return false;
        }, executionSignal);

        checkAbort();
        if (!approved) {
          return {
            content: [{ type: "text", text: "User declined to run command." }],
            details: { command, status: "Cancelled" },
            isError: true,
          };
        }

        const hostBash = createBashTool(cwd);
        publish("Running");
        checkAbort();
        const result = await hostBash.execute(
          toolCallId,
          { command, ...(params.timeout !== undefined ? { timeout: params.timeout } : {}) },
          executionSignal,
          (update) => onUpdate?.({ ...update, details: { ...update.details, command, status: "Running" } }),
          { ...ctx, cwd },
        );
        return { ...result, details: { ...result.details, command, status: result.isError ? "Failed" : "Completed" } };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: { command, status: executionSignal.aborted ? "Cancelled" : "Failed" },
          isError: true,
        };
      }
    },
  });
}
