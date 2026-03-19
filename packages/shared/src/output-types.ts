import { z } from "zod";

export const OUTPUT_TYPE_SCHEMAS = {
  telegram: z.object({ chatId: z.string() }),
  lark: z.object({ webhookUrl: z.string() }),
} as const;

export type OutputType = keyof typeof OUTPUT_TYPE_SCHEMAS;

export function validateOutputMeta(outputType: string, meta: unknown): boolean {
  const schema = OUTPUT_TYPE_SCHEMAS[outputType as OutputType];
  if (!schema) return false;
  return schema.safeParse(meta).success;
}
