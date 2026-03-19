import type { ResultMessage } from "@localagent/shared";

export function formatResultText(result: ResultMessage): string {
  const prefix = result.status === "ok" ? "" : "[ERROR] ";
  return `${prefix}Task ${result.taskId}:\n\n${result.output}`;
}
