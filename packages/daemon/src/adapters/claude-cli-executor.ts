import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Task, createLogger } from '@local-agent/shared';
import { TaskExecutor } from '../ports/task-executor';

const logger = createLogger('daemon:claude-cli');
const execFileAsync = promisify(execFile);

export class ClaudeCliExecutor implements TaskExecutor {
  async execute(task: Task): Promise<void> {
    logger.info({ task_id: task.task_id, task_type: task.task_type }, 'Spawning Claude Code');

    if (!task.payload) {
      logger.error({ task_id: task.task_id }, 'Task payload is missing or empty — skipping');
      return;
    }

    try {
      const { stdout, stderr } = await execFileAsync('claude', ['-p', task.payload], {
        maxBuffer: 50 * 1024 * 1024, // 50 MB — Claude Code responses can be large
      });

      logger.info(
        { task_id: task.task_id, stdout, stderr },
        'Claude Code completed',
      );
    } catch (err) {
      const execErr = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      logger.error(
        {
          task_id: task.task_id,
          exit_code: execErr.code,
          stdout: execErr.stdout,
          stderr: execErr.stderr,
        },
        'Claude Code failed',
      );
    }
  }
}
