import type { ResultMessage } from "@localagent/shared";

export interface EmitterPort {
  readonly outputType: string;
  emit(result: ResultMessage): Promise<void>;
}
