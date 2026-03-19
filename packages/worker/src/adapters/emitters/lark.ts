import type { EmitterPort } from "../../ports/emitter.js";
import type { ResultMessage } from "@localagent/shared";
import { OUTPUT_TYPE_SCHEMAS } from "@localagent/shared";
import { formatResultText } from "./format.js";

export class LarkEmitter implements EmitterPort {
  readonly outputType = "lark";

  async emit(result: ResultMessage): Promise<void> {
    const { webhookUrl } = OUTPUT_TYPE_SCHEMAS.lark.parse(result.outputMeta);
    const text = formatResultText(result);

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg_type: "text", content: { text } }),
    });
    if (!res.ok) throw new Error(`Lark webhook error: ${res.status}`);
  }
}
