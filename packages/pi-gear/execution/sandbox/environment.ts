import { isAbsolute } from "node:path";

export const commandEnvironment = (overrides: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv => ({ ...process.env, ...overrides });

export const commandShell = (): string => {
  const shell = process.env.SHELL;
  if (shell === undefined || shell === "") return "/bin/bash";
  if (!isAbsolute(shell)) throw new Error("SHELL must be an absolute path");
  return shell;
};
