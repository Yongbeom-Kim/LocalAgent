import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Task, createLogger } from '@local-agent/shared';

const logger = createLogger('daemon:handler');
const execFileAsync = promisify(execFile);

export async function handleTask(task: Task): Promise<void> {
  logger.info({ task_id: task.task_id, task_type: task.task_type }, 'Spawning Claude Code');

  try {
    const { stdout, stderr } = await execFileAsync('claude', ['-p', task.payload], {
      maxBuffer: 50 * 1024 * 1024, // 50 MB — Claude Code responses can be large
    });

    logger.info(
      { task_id: task.task_id, stdout, stderr },
      'Claude Code completed',
    );
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number };
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
