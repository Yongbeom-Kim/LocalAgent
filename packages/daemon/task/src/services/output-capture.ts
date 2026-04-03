import { MAX_RESULT_OUTPUT_BYTES } from '@local-agent/shared';

export class OutputCapture {
  private readonly chunks: Buffer[] = [];
  private totalBytes = 0;

  append(chunk: Buffer): void {
    if (this.totalBytes >= MAX_RESULT_OUTPUT_BYTES) {
      return;
    }

    const remaining = MAX_RESULT_OUTPUT_BYTES - this.totalBytes;
    const nextChunk = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
    this.chunks.push(nextChunk);
    this.totalBytes += nextChunk.byteLength;
  }

  read(): string {
    return Buffer.concat(this.chunks, this.totalBytes).toString('utf-8').replace(/\uFFFD$/, '');
  }
}
