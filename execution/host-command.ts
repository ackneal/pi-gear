import {
  createBashToolDefinition,
  type BashToolDetails,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { executionToolRenderers } from "../ui/tools/index.ts";
import { CONFIRMATION_TIMEOUT_MS, ConfirmationQueue } from "./confirmation-queue.ts";

export const REQUEST_COMMAND_TOOL_NAME = "request_command";

export const requestCommandParameters = Type.Object(
  {
    command: Type.String({ description: "Shell command for the user to review and run on the host." }),
    reason: Type.Optional(Type.String({ description: "Why this command needs to run on the host environment." })),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional)." })),
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

  if (ownsQueue) {
    const resetQueue = (): void => {
      confirmationQueue.reset();
    };
    pi.on("session_start", resetQueue);
    pi.on("session_shutdown", resetQueue);
  }

  pi.registerTool<typeof requestCommandParameters, CommandDetails>({
    name: REQUEST_COMMAND_TOOL_NAME,
    label: "Command",
    description:
      "Request interactive user approval to run a shell command directly on the host environment outside the sandbox.",
    promptSnippet:
      "Request user confirmation to run a command on the host when sandbox restrictions block a necessary operation.",
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

      let command = params.command;
      const publish = (status: CommandDetails["status"]): void => {
        onUpdate?.({ content: [], details: { command, status } });
      };
      const checkAbort = (): void => {
        if (signal?.aborted) {
          publish("Cancelled");
          throw new Error("Command aborted before execution.");
        }
      };

      try {
        checkAbort();
        publish("Waiting approval");
        const reason = params.reason?.trim();
        const directory = ctx.cwd !== process.cwd() ? ctx.cwd : undefined;
        const promptTitle = ["Run command?", reason, [directory, `$ ${command}`].filter(Boolean).join("\n")].filter(Boolean).join("\n\n");

        const approved = await confirmationQueue.confirm(async () => {
          checkAbort();
          const choice = await ctx.ui.select(
            promptTitle,
            ["Run", "Edit", "Cancel"],
            { timeout: CONFIRMATION_TIMEOUT_MS },
          );
          checkAbort();
          if (choice === "Run") return true;
          if (choice === "Edit") {
            const edited = await ctx.ui.editor("Edit command", command);
            checkAbort();
            if (edited === undefined || edited.trim() === "") return false;
            command = edited.trim();
            return true;
          }
          return false;
        });

        checkAbort();
        if (!approved) {
          return {
            content: [{ type: "text", text: "User declined to run command." }],
            details: { command, status: "Cancelled" },
            isError: true,
          };
        }

        const hostBash = createBashTool(ctx.cwd);
        publish("Running");
        checkAbort();
        const result = await hostBash.execute(
          toolCallId,
          { command, ...(params.timeout !== undefined ? { timeout: params.timeout } : {}) },
          signal,
          (update) => onUpdate?.({ ...update, details: { ...update.details, command, status: "Running" } }),
          ctx,
        );
        return { ...result, details: { ...result.details, command, status: result.isError ? "Failed" : "Completed" } };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: { command, status: signal?.aborted ? "Cancelled" : "Failed" },
          isError: true,
        };
      }
    },
  });
}
