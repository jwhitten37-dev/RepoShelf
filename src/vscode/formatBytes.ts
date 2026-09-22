export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

import type { WorkspaceDiskUsage } from "../infrastructure/workspaceRelease.js";

export type DiskUsagePresentation =
  | { readonly state: "measuring" }
  | { readonly state: "available"; readonly usage: WorkspaceDiskUsage }
  | { readonly state: "unavailable" };

export function diskUsageLabel(
  usage: DiskUsagePresentation | undefined,
): string {
  switch (usage?.state) {
    case "available":
      return formatBytes(usage.usage.totalBytes);
    case "measuring":
      return "Measuring…";
    case "unavailable":
    case undefined:
      return "Unavailable";
  }
}
