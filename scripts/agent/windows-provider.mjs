// Runs only inside windows-job.ps1's job. Provider arguments never become shell text.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const { argv, stdinText } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const child = spawn(argv[0], argv.slice(1), {
  windowsHide: true,
  stdio: [stdinText === null ? 'ignore' : 'pipe', 'inherit', 'inherit'],
});
if (stdinText !== null) {
  child.stdin.on('error', () => { /* provider closed stdin */ });
  child.stdin.end(stdinText);
}
child.on('error', (error) => { console.error(error.message); process.exitCode = 127; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
