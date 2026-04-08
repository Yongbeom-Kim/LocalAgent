import { loadSchedulerConfig } from './config';
import { renderCrontabAndSnapshot } from './cron-renderer';
import { loadMergedScheduleConfig } from './schedule-config';
import { submitScheduleByName } from './submitter';

async function main(): Promise<void> {
  const config = loadSchedulerConfig();
  const mode = process.argv[2];

  if (mode === 'render') {
    const scheduleConfig = loadMergedScheduleConfig(config.scheduleConfigDir);
    renderCrontabAndSnapshot({
      scheduleConfig,
      crontabPath: config.crontabPath,
      configSnapshotPath: config.configSnapshotPath,
      distEntryPath: config.distEntryPath,
    });
    return;
  }

  if (mode === 'run') {
    const scheduleName = process.argv[3];
    if (!scheduleName) {
      throw new Error('schedule name is required for run mode');
    }

    await submitScheduleByName(
      {
        apiUrl: config.apiUrl,
        apiAuthEnabled: config.apiAuthEnabled,
        apiAuthToken: config.apiAuthToken,
        configSnapshotPath: config.configSnapshotPath,
      },
      scheduleName,
    );
    return;
  }

  throw new Error('usage: node dist/index.js <render|run <schedule-name>>');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
