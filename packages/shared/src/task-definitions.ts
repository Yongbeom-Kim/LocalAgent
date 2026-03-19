import { z } from "zod";
import { defineTaskType } from "./task-types.js";

export const codeReviewTaskType = defineTaskType({
  name: "code_review",
  payloadSchema: z.object({
    repo: z.string(),
    pr: z.number(),
    instructions: z.string().optional(),
  }),
  promptTemplate: "Review PR #{{pr}} in {{repo}}. {{instructions}}",
  timeout: 1_800_000,
});

export const promptTaskType = defineTaskType({
  name: "prompt",
  payloadSchema: z.object({
    prompt: z.string(),
  }),
  promptTemplate: "{{prompt}}",
});
