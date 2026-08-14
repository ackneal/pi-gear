import type { AccessPolicy } from "../../config/index.ts";

export type NetworkDecision = "allow" | "ask" | "deny";

const matchesHost = (selector: string, host: string, port: number | undefined): boolean => {
  const separator = selector.lastIndexOf(":");
  const selectorPort = separator === -1 ? undefined : Number(selector.slice(separator + 1));
  const selectorHost = separator === -1 ? selector : selector.slice(0, separator);
  if (selectorPort !== undefined && selectorPort !== port) return false;
  return selectorHost.startsWith("*.") ? host.endsWith(selectorHost.slice(1)) && host !== selectorHost.slice(2) : host === selectorHost;
};

export const evaluateNetwork = (policy: AccessPolicy, host: string, port?: number): NetworkDecision => {
  const matches = policy.network.rules.filter((rule) => matchesHost(rule.host, host.toLowerCase(), port));
  if (matches.some((rule) => rule.access === "deny")) return "deny";
  if (matches.some((rule) => rule.access === "allow")) return "allow";
  return policy.network.defaultAccess;
};
