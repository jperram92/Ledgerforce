// HANDOVER.md (design §10.5): header fields filled from state + card, narrative placeholders
// for the agent, and an append-only "## Log" section that survives every rewrite.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { iso } from './util.ts';

export interface HandoverInput {
  at: number;
  from: string;
  run: string;
  reason: string;
  taskId: string | null;
  taskTitle: string;
  branch: string;
  lastGreen: string | null;
  cardBody: string;
}

export const PLACEHOLDER = {
  inProgress: '[agent: what is half-done; failing tests with file paths]',
  next: '[agent: the single next command or edit to make]',
  decisions: '[agent: DL/ADR ids taken this session, or "none new"]',
  questions: '[agent: questions that need the human, or "none"]',
};

const DO_NOT = 'edit Approved golden files in Docs/accounting/; delete or rename tracked files; skip/weaken tests; push to main; edit .env*';

function steps(body: string): { done: string[]; open: string[] } {
  const done: string[] = [];
  const open: string[] = [];
  for (const l of body.split('\n')) {
    const m = l.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (!m) continue;
    (m[1] === ' ' ? open : done).push(m[2].trim());
  }
  return { done, open };
}

function field(text: string, name: string): string | null {
  const m = text.match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'm'));
  return m ? m[1].trim() : null;
}

function isPlaceholder(v: string | null): boolean {
  return !v || v.startsWith('[agent:');
}

export function renderHandover(i: HandoverInput, previous: string | null): string {
  const d = iso(i.at);
  const header = `# Handover - ${d.slice(0, 10)} ${d.slice(11, 16)} UTC`;
  const st = steps(i.cardBody);
  const task = i.taskId ? `${i.taskId} ${i.taskTitle}`.trim() : 'none (no active task)';
  const sameTask = previous !== null && i.taskId !== null && (field(previous, 'Task') ?? '').startsWith(i.taskId);
  // Narrative fields an agent already filled in for this task are carried over, never wiped.
  const keep = (name: string, ph: string): string => {
    const v = sameTask ? field(previous!, name) : null;
    return isPlaceholder(v) ? ph : v!;
  };
  const inProgressStep = st.open[0] ? `${st.open[0]} — ` : '';
  const prevIP = sameTask ? field(previous!, 'In progress') : null;
  const inProgress = prevIP && !prevIP.includes('[agent:') && prevIP.startsWith(inProgressStep) ? prevIP : `${inProgressStep}${PLACEHOLDER.inProgress}`;
  const lines = [
    header,
    `From: ${i.from} (run ${i.run})    Reason: ${i.reason}`,
    `Task: ${task}`,
    `Branch: ${i.branch}   Last green commit: ${i.lastGreen ? i.lastGreen.slice(0, 7) : 'none'}`,
    `Done: ${st.done.length ? st.done.join('; ') : 'nothing checked off yet'}`,
    `In progress: ${inProgress}`,
    `Next action: ${keep('Next action', PLACEHOLDER.next)}`,
    `Decisions taken: ${keep('Decisions taken', PLACEHOLDER.decisions)}`,
    `Open questions for human: ${keep('Open questions for human', PLACEHOLDER.questions)}`,
    `Do not: ${DO_NOT}`,
    '',
    '## Log',
    '',
  ];
  const prevLog = previous ? logSection(previous) : '';
  return lines.join('\n') + (prevLog ? prevLog.replace(/\n*$/, '\n') : '');
}

function logSection(text: string): string {
  const idx = text.search(/^## Log[ \t]*$/m);
  if (idx < 0) return '';
  return text.slice(idx).replace(/^## Log[ \t]*\n+/, '');
}

export function writeHandover(file: string, input: HandoverInput, logLine?: string): void {
  const prev = existsSync(file) ? readFileSync(file, 'utf8') : null;
  let text = renderHandover(input, prev);
  if (logLine) text = text.replace(/\n*$/, '\n') + `- ${logLine}\n`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** Append a line to the Log section (creating a minimal file if needed). */
export function appendHandoverLog(file: string, line: string, create: () => string): void {
  let text = existsSync(file) ? readFileSync(file, 'utf8') : create();
  if (!/^## Log[ \t]*$/m.test(text)) text = text.replace(/\n*$/, '\n\n## Log\n\n');
  text = text.replace(/\n*$/, '\n') + `- ${line}\n`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
