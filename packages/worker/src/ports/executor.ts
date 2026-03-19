export interface ExecutionResult {
  success: boolean;
  output: string;
}

export interface ExecutorPort {
  execute(prompt: string, options: {
    allowedTools?: string[];
    maxTokens?: number;
    timeout: number;
  }): Promise<ExecutionResult>;
}
