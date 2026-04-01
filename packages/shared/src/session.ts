import { uuidv7 } from 'uuidv7';

export function generateSessionId(): string {
  return uuidv7();
}
