#!/usr/bin/env node
import { Command } from 'commander';
import { registerSubmitCommand } from './commands/submit';

async function main() {
  const program = new Command();

  program
    .name('local-agent')
    .description('CLI for the LocalAgent task queue')
    .version('0.0.1');

  registerSubmitCommand(program);

  await program.parseAsync();
}

main();
