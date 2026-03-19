import type { EmitterPort } from "../../ports/emitter.js";
import type { ResultMessage } from "@localagent/shared";

export class LarkEmitter implements EmitterPort {
  readonly outputType = "lark";

  async emit(result: ResultMessage): Promise<void> {
    const webhookUrl = (result.outputMeta as { webhookUrl: string }).webhookUrl;
    const prefix = result.status === "ok" ? "" : "[ERROR] ";
    const text = `${prefix}Task ${result.taskId}:\n\n${result.output}`;

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg_type: "text", content: { text } }),
    });
    if (!res.ok) throw new Error(`Lark webhook error: ${res.status}`);
  }
}
