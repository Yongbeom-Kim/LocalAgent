import { z } from "zod";

export const TaskMessageSchema = z.object({
  taskId: z.string(),
  type: z.string(),
  outputType: z.string(),
  outputMeta: z.record(z.unknown()),
  payload: z.record(z.unknown()),
});
export type TaskMessage = z.infer<typeof TaskMessageSchema>;

export const JobMessageSchema = z.object({
  taskId: z.string(),
  type: z.string(),
  prompt: z.string(),
  allowedTools: z.array(z.string()).optional(),
  maxTokens: z.number().optional(),
  timeout: z.number(),
  outputType: z.string(),
  outputMeta: z.record(z.unknown()),
});
export type JobMessage = z.infer<typeof JobMessageSchema>;

export const ResultMessageSchema = z.object({
  taskId: z.string(),
  status: z.enum(["ok", "error"]),
  output: z.string(),
  outputType: z.string(),
  outputMeta: z.record(z.unknown()),
});
export type ResultMessage = z.infer<typeof ResultMessageSchema>;
