import { execFile } from 'node:child_process';
import { Task, TaskResultSubmission, MAX_RESULT_OUTPUT_BYTES, createLogger, truncate } from '@local-agent/shared';
import { TaskExecutor } from '../ports/task-executor';

const logger = createLogger('task-daemon:claude-cli');

export class ClaudeCliExecutor implements TaskExecutor {
  async execute(task: Task): Promise<TaskResultSubmission> {
    logger.info({ task_id: task.task_id, task_type: task.task_type }, 'Spawning Claude Code');

    if (!task.payload) {
      logger.error({ task_id: task.task_id }, 'Task payload is missing or empty — skipping');
      return {
        task_id: task.task_id,
        status: 'failure',
        exit_code: null,
        stdout: '',
        stderr: 'Task payload is missing or empty',
      };
    }

    return new Promise((resolve) => {
      execFile(
        'claude',
        ['--dangerously-skip-permissions', '--model', task.executor_model, '-p', task.payload],
        { maxBuffer: 50 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            const execErr = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
            logger.error(
              { task_id: task.task_id, exit_code: execErr.code, stdout: execErr.stdout, stderr: execErr.stderr },
              'Claude Code failed',
            );

            resolve({
              task_id: task.task_id,
              status: 'failure',
              exit_code: typeof execErr.code === 'number' ? execErr.code : null,
              stdout: truncate(execErr.stdout ?? '', MAX_RESULT_OUTPUT_BYTES),
              stderr: truncate(execErr.stderr ?? '', MAX_RESULT_OUTPUT_BYTES),
            });
          } else {
            logger.info({ task_id: task.task_id, stdout, stderr }, 'Claude Code completed');

            resolve({
              task_id: task.task_id,
              status: 'success',
              exit_code: 0,
              stdout: truncate(stdout, MAX_RESULT_OUTPUT_BYTES),
              stderr: truncate(stderr, MAX_RESULT_OUTPUT_BYTES),
            });
          }
        },
      );
    });
  }
}
