import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Task, createLogger } from '@local-agent/shared';
import { TaskExecutor } from '../ports/task-executor';

const logger = createLogger('daemon:ttadk');
const execFileAsync = promisify(execFile);

export class TTADKExecutor implements TaskExecutor {
  async execute(task: Task): Promise<void> {
    logger.info({ task_id: task.task_id, task_type: task.task_type }, 'Spawning TTADK');

    if (!task.payload) {
      logger.error({ task_id: task.task_id }, 'Task payload is missing or empty — skipping');
      return;
    }

    try {
      // Available models: glm-5-ttadk, kimi-k2.5, glm-4.7-ttadk, gpt-5.3-codex, gpt-5.4, gpt-5.2-codex
      const { stdout, stderr } = await execFileAsync(
        'ttadk',
        ['code', '-t', 'claude', '-m', 'gpt-5.4', '-a', `--dangerously-skip-permissions -p ${task.payload}`],
        {
          maxBuffer: 50 * 1024 * 1024,
        },
      );

      logger.info({ task_id: task.task_id, stdout, stderr }, 'TTADK completed');
    } catch (err) {
      const execErr = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      logger.error(
        {
          task_id: task.task_id,
          exit_code: execErr.code,
          stdout: execErr.stdout,
          stderr: execErr.stderr,
        },
        'TTADK failed',
      );
    }
  }
}
