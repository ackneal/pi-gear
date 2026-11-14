import type { SubagentActivity } from "./runtime/types.ts";

function isActivity(value: unknown): value is SubagentActivity {
  if (!value || typeof value !== "object") return false;
  const activity = value as Record<string, unknown>;
  if (activity.kind === "thinking") {
    return typeof activity.text === "string"
      && (activity.contentIndex === undefined || typeof activity.contentIndex === "number")
      && (activity.messageId === undefined || typeof activity.messageId === "number");
  }
  return activity.kind === "tool" && typeof activity.name === "string"
    && (activity.status === "running" || activity.status === "success" || activity.status === "error")
    && (activity.id === undefined || typeof activity.id === "string")
    && (activity.result === undefined || typeof activity.result === "string")
    && (activity.args === undefined || (activity.args !== null && typeof activity.args === "object" && !Array.isArray(activity.args)));
}

function isHistory(value: unknown): value is SubagentActivity[] {
  return Array.isArray(value) && value.every(isActivity);
}

export function normalizeRunActivities<T extends object>(run: T): Omit<T, "items" | "itemsTruncated" | "activities" | "activitiesTruncated" | "toolActivitiesTruncated"> & {
  activities: SubagentActivity[];
  activitiesTruncated?: boolean;
  toolActivitiesTruncated?: boolean;
} {
  const { items, itemsTruncated, activities, activitiesTruncated, toolActivitiesTruncated, ...fields } = run as T & {
    items?: unknown;
    itemsTruncated?: unknown;
    activities?: unknown;
    activitiesTruncated?: unknown;
    toolActivitiesTruncated?: unknown;
  };
  const history = isHistory(activities) ? activities : isHistory(items) ? items : [];
  const truncated = typeof activitiesTruncated === "boolean" ? activitiesTruncated
    : typeof itemsTruncated === "boolean" ? itemsTruncated : undefined;
  const toolsTruncated = typeof toolActivitiesTruncated === "boolean" ? toolActivitiesTruncated : undefined;

  return {
    ...fields,
    activities: history,
    ...(truncated === undefined ? {} : { activitiesTruncated: truncated }),
    ...(toolsTruncated === undefined ? {} : { toolActivitiesTruncated: toolsTruncated }),
  };
}
