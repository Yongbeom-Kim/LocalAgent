import { spawn } from "node:child_process";
import type { ExecutorPort, ExecutionResult } from "../../ports/executor.js";

export class ClaudeCliExecutor implements ExecutorPort {
  async execute(prompt: string, options: { allowedTools?: string[]; maxTokens?: number; timeout: number }): Promise<ExecutionResult> {
    return new Promise<ExecutionResult>((resolve) => {
      const args = ["-p", prompt, "--output-format", "stream-json"];
      if (options.allowedTools?.length) {
        for (const tool of options.allowedTools) args.push("--allowedTools", tool);
      }
      if (options.maxTokens) args.push("--max-tokens", String(options.maxTokens));

      const proc = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"], detached: true });

      let stdout = "";
      let stderr = "";
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        if (proc.pid) { try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); } }
      }, options.timeout);

      proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.on("close", (code) => {
        clearTimeout(timer);
        if (killed) { resolve({ success: false, output: `Task timed out after ${options.timeout}ms` }); return; }
        if (code !== 0) { resolve({ success: false, output: stderr || `Claude CLI exited with code ${code}` }); return; }
        resolve({ success: true, output: parseStreamJson(stdout) });
      });
    });
  }
}

function parseStreamJson(raw: string): string {
  const lines = raw.split("\n").filter(Boolean);
  const texts: string[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "assistant" && Array.isArray(obj.content)) {
        for (const block of obj.content) {
          if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
        }
      }
    } catch { /* skip malformed */ }
  }
  return texts.join("\n");
}
