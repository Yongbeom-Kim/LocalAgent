import pino from 'pino';

export function createLogger(name: string, level: string = 'info'): pino.Logger {
  return pino({ name, level });
}
