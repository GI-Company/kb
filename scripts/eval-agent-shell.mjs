#!/usr/bin/env node
// Eval harness for the terminal's `?` natural-language translator.
//
// WHY THIS EXISTS: the model behind agent-shell was chosen by measurement,
// not preference. allam-2-7b answered "show me my files" with `files: ls` —
// echoing a category label straight out of the prompt — and "find the
// biggest files" with `df -h`. llama-3.3-70b-versatile scored 6/7 on the
// cases below. That comparison lived in a chat transcript, which meant the
// next person to swap models would have had nothing to compare against and
// would have judged it on two hand-typed examples.
//
// So: same prompts, same persona, same endpoint production uses. Run it
// before and after any model change.
//
//   npm run eval:shell                     # against a local dev server
//   EVAL_URL=https://kb-phi-beryl.vercel.app npm run eval:shell
//
// Deliberately NOT part of `npm test`. It costs real Groq calls and depends
// on a running server and a non-deterministic model — a suite that fails
// for those reasons trains people to ignore it.

const BASE = process.env.EVAL_URL || 'http://localhost:3000';
/** Spacing between calls, to stay under /api/chat's per-minute limit. */
const GAP_MS = Number(process.env.EVAL_GAP_MS) || 2000;
const AGENT = 'agent-shell';

/** Commands that exist. Anything outside this is a dead command — see api/exec.ts. */
const REAL = new Set([
  // client-side, against the VFS
  'ls', 'cat', 'cd', 'pwd', 'mkdir', 'touch', 'write', 'rm', 'mv', 'cp',
  'grep', 'wc', 'head', 'tail', 'sort', 'uniq', 'echo', 'cut', 'sed', 'awk', 'tr',
  'python', 'python3', 'pip',
  // server-side / native
  'diff', 'stat', 'date', 'whoami', 'uname', 'id', 'env', 'df', 'du',
  'curl', 'dig', 'ping', 'render',
]);

/** The exact failures that motivated the last model change. */
const KNOWN_DEAD = ['find', 'jq', 'node', 'npm', 'npx', 'which', 'ps', 'hostname', 'tar', 'gzip', 'file'];

const CASES = [
  {
    prompt: 'show me my files',
    accept: ['ls', 'ls -l', 'ls -la'],
    note: 'allam-2-7b answered `files: ls` here, echoing the prompt\'s category label',
  },
  {
    prompt: 'count the lines in fruit.txt',
    accept: ['wc -l fruit.txt'],
  },
  {
    prompt: "what's in notes.md",
    accept: ['cat notes.md'],
  },
  {
    // No `find` on this runtime, so the only correct answers work around it.
    // This is the case that catches a model translating against generic
    // Unix knowledge instead of the command list it was given.
    prompt: 'find the biggest files',
    acceptIf: (cmd) => !startsWithDead(cmd) && REAL.has(head(cmd)),
    describe: 'any real command; must not reach for `find`',
    note: 'allam-2-7b answered `df -h`, which reports disk usage, not file sizes',
  },
  {
    prompt: 'delete notes.md',
    accept: ['rm notes.md'],
    note: 'Terminal.tsx stages this rather than auto-running it — see MUTATING_COMMANDS',
  },
  {
    prompt: 'run python to print 2+2',
    accept: ['python -c "print(2+2)"', "python -c 'print(2+2)'", 'python -c "print(2 + 2)"'],
  },
  {
    prompt: 'list the files in the demo folder',
    accept: ['ls demo', 'ls demo/', 'ls ./demo'],
  },
];

/** Score at the time agent-shell was set to llama-3.3-70b-versatile. */
const BASELINE = 6;

class RateLimited extends Error {}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const head = (cmd) => cmd.trim().split(/\s+/)[0];
const startsWithDead = (cmd) => KNOWN_DEAD.includes(head(cmd));

async function translate(prompt) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: AGENT, message: prompt, history: [] }),
  });
  if (res.status === 429) {
    // Seven prompts back-to-back sits close to the per-minute chat limit,
    // so a second run in the same minute will hit this. Worth its own
    // message: "unreachable, start the server" sent me looking in the
    // wrong place the first time it happened.
    throw new RateLimited();
  }
  if (!res.ok) throw new Error(`/api/chat returned ${res.status}`);
  const body = await res.text();
  // NDJSON of {"chunk": "..."} — the same stream services/kernel.ts consumes.
  return body
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line).chunk || ''; } catch { return ''; } })
    .join('')
    .trim();
}

function judge(testCase, reply) {
  if (testCase.acceptIf) return testCase.acceptIf(reply);
  return testCase.accept.some(a => a.toLowerCase() === reply.toLowerCase());
}

async function main() {
  console.log(`agent-shell eval → ${BASE}\n`);

  let passed = 0;
  const failures = [];

  for (const [i, testCase] of CASES.entries()) {
    if (i > 0) await sleep(GAP_MS);
    let reply;
    try {
      reply = await translate(testCase.prompt);
    } catch (err) {
      if (err instanceof RateLimited) {
        console.error(`\n✖ /api/chat rate-limited after ${passed + failures.length} of ${CASES.length} cases.`);
        console.error('  Wait a minute and re-run, or raise EVAL_GAP_MS to space the calls out.\n');
      } else {
        console.error(`\n✖ ${BASE} unreachable: ${err.message}`);
        console.error('  Start the dev server (npm run dev) or set EVAL_URL to a deployment.\n');
      }
      // Exit 2, distinct from a real quality regression (1) — a harness that
      // couldn't run is not the same as a model that got worse.
      process.exit(2);
    }

    const ok = judge(testCase, reply);
    if (ok) passed++;
    else failures.push({ ...testCase, reply });

    const expected = testCase.describe || testCase.accept.join('  |  ');
    console.log(`${ok ? '✓' : '✗'} ${testCase.prompt}`);
    console.log(`    got:      ${reply || '(empty)'}`);
    if (!ok) console.log(`    expected: ${expected}`);
    // A dead command is worth calling out even when the case passed on a
    // technicality — it's the specific regression this eval exists for.
    if (startsWithDead(reply)) console.log(`    ⚠ \`${head(reply)}\` does not exist on this runtime`);
  }

  console.log(`\n${passed}/${CASES.length}  (baseline when this model was chosen: ${BASELINE}/${CASES.length})`);

  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  • ${f.prompt}\n      got ${f.reply || '(empty)'}`);
      if (f.note) console.log(`      context: ${f.note}`);
    }
  }

  if (passed < BASELINE) {
    console.log(`\nBelow baseline. Do not ship this model change on the strength of a couple of hand-typed examples.`);
    process.exit(1);
  }
  console.log('\nAt or above baseline.');
}

main();
