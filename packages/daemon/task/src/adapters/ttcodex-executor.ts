import { spawn } from 'node:child_process';
import { JobAttempt, TaskResultSubmission, MAX_RESULT_OUTPUT_BYTES, createLogger, truncate } from '@local-agent/shared';
import { ExecutorPrecheckResult, TaskExecutionHooks, TaskExecutor } from '../ports/task-executor';
import { ExecutionEnvironment } from '../services/job-environment';
import { checkRequiredBinaries } from './executor-precheck';
import { attachProcessCancellation } from '../services/process-cancellation';

const logger = createLogger('task-daemon:ttcodex');
const REQUIRED_BINARIES = ['ttadk', 'codex'] as const;

export class TTCodexExecutor implements TaskExecutor {
  async precheck(_env: ExecutionEnvironment): Promise<ExecutorPrecheckResult> {
    return checkRequiredBinaries('ttcodex', REQUIRED_BINARIES);
  }

  async execute(job: JobAttempt, env: ExecutionEnvironment, hooks?: TaskExecutionHooks): Promise<TaskResultSubmission> {
    logger.info({ job_id: job.job_id, task_id: job.task_id, task_type: job.task_type }, 'Spawning TTCodex');

    if (!job.payload) {
      logger.error({ job_id: job.job_id, task_id: job.task_id }, 'Job payload is missing or empty — skipping');
      return {
        job_id: job.job_id,
        task_id: job.task_id,
        task_type: job.task_type,
        status: 'failure',
        exit_code: null,
        stdout: '',
        stderr: 'Job payload is missing or empty',
      };
    }

    // TTADK codex mode does not support plugin directory/marketplace forwarding in v1.
    if (env.pluginDirs.length > 0) {
      logger.debug(
        { job_id: job.job_id, task_id: job.task_id, plugin_count: env.pluginDirs.length },
        'TTCodex executor ignores plugin directories in v1',
      );
    }

    if (env.isExistingWorkspace && !job.skipContinue) {
      const continueResult = await this.spawnTTCodex(job, env, {
        mode: 'continue',
        input: job.payload,
      }, hooks);

      if (continueResult.status === 'success') {
        return continueResult;
      }

      logger.warn(
        { job_id: job.job_id, task_id: job.task_id, exit_code: continueResult.exit_code, stderr: continueResult.stderr },
        'TTCodex continue failed, falling back to fresh session',
      );
    }

    return this.spawnTTCodex(job, env, {
      mode: 'fresh',
      input: this.buildFreshInput(job),
    }, hooks);
  }

  private buildFreshInput(job: JobAttempt): string {
    if (!job.history) {
      return job.payload;
    }

    return `--- Thread Context ---\n${job.history}\n--- Current Message ---\n${job.payload}`;
  }

  private buildPromptForArgv(job: JobAttempt, input: string): string {
    if (job.system_prompt) {
      return `--- System ---\n${job.system_prompt}\n--- User ---\n${input}`;
    }
    return input;
  }

  private buildActionArg(options: { mode: 'continue' | 'fresh' }): string {
    if (options.mode === 'continue') {
      return 'exec resume --last --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check';
    }

    return 'exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check';
  }

  private sanitizeOutput(raw: string): string {
    const lines = raw.split(/\r?\n/);
    const filtered = lines.filter((line) => !this.isWrapperLine(line));
    return filtered.join('\n').trim();
  }

  private isWrapperLine(line: string): boolean {
    const trimmed = line.trim();

    if (!trimmed) {
      return false;
    }

    // Strip only the observed TTADK ASCII-art banner shapes, not arbitrary punctuation output.
    if (/^[_|/\\.' ]{10,}$/.test(trimmed)) {
      return true;
    }

    if (/^={10,}$/.test(trimmed)) {
      return true;
    }

    if (trimmed === 'TikTok AI-Driven Development Kit') {
      return true;
    }

    if (trimmed.startsWith('Version ')) {
      return true;
    }

    if (trimmed.startsWith('Team: ')) {
      return true;
    }

    if (trimmed.includes('Launching Codex CLI')) {
      return true;
    }

    if (trimmed.includes('Login successful')) {
      return true;
    }

    if (/codebase\s+repo/i.test(trimmed)) {
      return true;
    }

    return false;
  }

  private spawnTTCodex(
    job: JobAttempt,
    env: ExecutionEnvironment,
    options: { mode: 'continue' | 'fresh'; input: string },
    hooks?: TaskExecutionHooks,
  ): Promise<TaskResultSubmission> {
    const promptString = this.buildPromptForArgv(job, options.input);
    const actionArg = this.buildActionArg(options);
    const args = ['code', '-m', job.executor_model, '-t', 'codex', '-a', actionArg];

    return new Promise((resolve) => {
      const child = spawn('ttadk', args, { cwd: env.workDir, shell: false, detached: process.platform !== 'win32' });
      attachProcessCancellation(child, hooks);
      let stdout = '';
      let stderr = '';
      child.stdin.write(promptString);
      child.stdin.end();

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('close', (code) => {
        const sanitizedStdout = this.sanitizeOutput(stdout);
        const sanitizedStderr = this.sanitizeOutput(stderr);
        const resolvedStdout = sanitizedStdout || sanitizedStderr;

        if (code !== 0) {
          logger.error(
            { job_id: job.job_id, task_id: job.task_id, mode: options.mode, exit_code: code },
            'TTCodex failed',
          );

          resolve({
            job_id: job.job_id,
            task_id: job.task_id,
            task_type: job.task_type,
            status: 'failure',
            exit_code: code,
            stdout: truncate(resolvedStdout, MAX_RESULT_OUTPUT_BYTES),
            stderr: truncate(sanitizedStderr, MAX_RESULT_OUTPUT_BYTES),
          });
        } else {
          logger.info(
            { job_id: job.job_id, task_id: job.task_id, mode: options.mode },
            'TTCodex completed',
          );

          resolve({
            job_id: job.job_id,
            task_id: job.task_id,
            task_type: job.task_type,
            status: 'success',
            exit_code: 0,
            stdout: truncate(resolvedStdout, MAX_RESULT_OUTPUT_BYTES),
            stderr: truncate(sanitizedStderr, MAX_RESULT_OUTPUT_BYTES),
          });
        }
      });

      child.on('error', (err) => {
        logger.error(
          { job_id: job.job_id, task_id: job.task_id, mode: options.mode, error: err.message },
          'Failed to spawn TTCodex',
        );

        resolve({
          job_id: job.job_id,
          task_id: job.task_id,
          task_type: job.task_type,
          status: 'failure',
          exit_code: null,
          stdout: '',
          stderr: err.message,
        });
      });
    });
  }
}
