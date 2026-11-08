export const validFilesystemSelector = (path: string): boolean => {
  if (path.includes("\\") || path === "~" || path.startsWith("~/") && path.length === 2) return false;
  const suffix = path.startsWith("~/") ? path.slice(2) : path.startsWith("/") ? path.slice(1) : path;
  return suffix.length > 0 && suffix.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".." && !/[?\[\]{}]/.test(segment) && !/\*{3,}/.test(segment));
};
