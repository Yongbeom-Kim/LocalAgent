#!/usr/bin/env node

const { readFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { join, resolve } = require('node:path');

const repoRoot = resolve(__dirname, '..', '..');
const rushJsonPath = join(repoRoot, 'rush.json');
const rushxScriptPath = join(repoRoot, 'common', 'scripts', 'install-run-rushx.js');

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function getTestProjects() {
  const rushConfig = readJson(rushJsonPath);

  return rushConfig.projects
    .map((project) => {
      const packageJsonPath = join(repoRoot, project.projectFolder, 'package.json');
      const packageJson = readJson(packageJsonPath);
      const testScript = packageJson.scripts && packageJson.scripts.test;

      return {
        packageName: project.packageName,
        projectFolder: project.projectFolder,
        testScript,
      };
    })
    .filter((project) => typeof project.testScript === 'string' && project.testScript.trim().length > 0);
}

function runPackageTest(projectFolder) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [rushxScriptPath, 'test'], {
      cwd: join(repoRoot, projectFolder),
      stdio: 'inherit',
    });

    child.on('error', rejectPromise);
    child.on('close', (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`Test process exited from signal ${signal}`));
        return;
      }

      resolvePromise(code === null ? 1 : code);
    });
  });
}

async function main() {
  const projects = getTestProjects();

  if (projects.length === 0) {
    console.log('No Rush projects define a test script.');
    process.exit(0);
  }

  console.log('Discovered test projects:');
  for (const project of projects) {
    console.log(`- ${project.packageName} (${project.projectFolder})`);
  }

  const failures = [];

  for (const project of projects) {
    console.log(`\n==> Testing ${project.packageName} (${project.projectFolder})`);
    const exitCode = await runPackageTest(project.projectFolder);

    if (exitCode !== 0) {
      failures.push(project.packageName);
    }
  }

  if (failures.length > 0) {
    console.error(`\nTest failures: ${failures.join(', ')}`);
    process.exit(1);
  }

  console.log('\nAll Rush project tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
