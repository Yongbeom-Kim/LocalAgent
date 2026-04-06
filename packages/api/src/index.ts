import { loadApiConfig, loadApiAuthConfig, createLogger } from '@local-agent/shared';
import { RabbitMQService } from './services/rabbitmq';
import { createApp } from './app';

async function main() {
  const config = loadApiConfig();
  const auth = loadApiAuthConfig();
  const logger = createLogger('api', config.logLevel);

  const rabbitmq = new RabbitMQService(config.rabbitmqUrl, config.queueName);

  let retries = 0;
  const maxRetries = 10;
  while (retries < maxRetries) {
    try {
      await rabbitmq.connect();
      logger.info('Connected to RabbitMQ');
      break;
    } catch (err) {
      retries++;
      const delay = Math.min(1000 * Math.pow(2, retries), 30000);
      logger.warn({ err, retries, delay }, 'Failed to connect to RabbitMQ, retrying...');
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  if (retries >= maxRetries) {
    logger.fatal('Could not connect to RabbitMQ after max retries');
    process.exit(1);
  }

  const app = createApp(rabbitmq, auth);

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'API server started');
  });

  const shutdown = async () => {
    logger.info('Shutting down...');
    server.close();
    await rabbitmq.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  const logger = createLogger('api');
  logger.fatal({ err }, 'Fatal error');
  process.exit(1);
});
