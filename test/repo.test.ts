// What is committed to git - checked against `git ls-files`, not the folder,
// because the folder on this computer can contain files no repository has.
// Hand-written sources must be tracked (or the app breaks for everyone else);
// build output must not be (or it goes stale silently).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { projectDir } from './helpers.ts';

/** Everything git is tracking, as forward-slash paths. */
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: projectDir, encoding: 'utf8' }).split('\0').filter((f) => f !== '');
}

/** True if git would ignore this path. */
function isIgnored(file: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', file], { cwd: projectDir });
    return true;
  } catch {
    return false;
  }
}

/** The rules, as a function of the tracked list, so the check itself can be tested. */
export function repoProblems(tracked: readonly string[], ignored: (file: string) => boolean): string[] {
  const problems: string[] = [];
  const has = (file: string): boolean => tracked.includes(file);
  const mustBeTracked = [
    'src/renderer/index.html',
    'src/renderer/styles.css',
    'src/renderer/app.ts',
    'src/main/main.ts',
    'src/main/preload.cts',
    'src/shared/types.d.ts',
    'requirements.json',
    'setup.ps1',
    'package.json',
    'package-lock.json',
    '.gitattributes',
    '.gitignore',
    'assets/icon.png',
    'README.md',
  ];
  for (const file of mustBeTracked) if (!has(file)) problems.push(`${file} is not committed`);
  for (const file of ['src/renderer/app.js', 'dist/main/main.js', 'dist/main/preload.cjs']) {
    if (has(file)) problems.push(`${file} is build output but is committed`);
    if (!ignored(file)) problems.push(`${file} is build output but is not in .gitignore`);
  }
  for (const file of tracked) {
    if (/\.(js|mjs|cjs|jsx)$/i.test(file)) problems.push(`${file} is a plain JavaScript file`);
    if (/\.(bat|cmd)$/i.test(file)) problems.push(`${file} is a batch file`);
    if (/\.ps1$/i.test(file) && file !== 'setup.ps1' && !file.startsWith('build/')) problems.push(`${file} is a second script outside build/`);
    if (/^(dist|release|node_modules)\//.test(file)) problems.push(`${file} is generated and should not be committed`);
  }
  return problems;
}

test('hand-written sources are committed; build output is not', () => {
  assert.deepEqual(repoProblems(trackedFiles(), isIgnored), []);
});

test('the check above notices when something is wrong', () => {
  const good = trackedFiles();
  const withoutHtml = good.filter((f) => f !== 'src/renderer/index.html');
  assert.deepEqual(repoProblems(withoutHtml, isIgnored), ['src/renderer/index.html is not committed']);
  assert.ok(repoProblems([...good, 'src/renderer/app.js'], isIgnored).some((p) => p.includes('app.js is build output but is committed')));
  assert.ok(repoProblems([...good, 'tools/helper.bat'], isIgnored).some((p) => p.includes('batch file')));
  assert.ok(repoProblems(good, () => false).some((p) => p.includes('not in .gitignore')));
});

test('line endings are pinned, and the setup script is stored with Windows line endings', () => {
  const attributes = execFileSync('git', ['check-attr', 'eol', '--', 'setup.ps1', 'src/main/main.ts'], { cwd: projectDir, encoding: 'utf8' });
  assert.match(attributes, /setup\.ps1: eol: crlf/);
  assert.match(attributes, /main\.ts: eol: lf/);
});
