/**
 * Shared campsite-rule hook adapter for all IDE hosts.
 *
 * Translates host-specific hook payloads into engine calls and emits
 * the JSON responses each host expects.  The engine and all detection
 * logic live in the campsite-rule package at `src/` — this adapter
 * owns only payload normalization and response formatting.
 *
 * Usage:
 *   node .agents/skills/campsite-rule/bin/hook.js --host cursor --repo . <mode>
 *   node .agents/skills/campsite-rule/bin/hook.js --host claude --repo "$PWD" <mode>
 *
 * Modes: session-start, tool-success, tool-failure, agent-response,
 * agent-thought, stop, subagent-stop, pretool, resolve
 *
 * @see .agents/skills/campsite-rule/SKILL.md — the policy this hook reinforces
 * @see docs/decisions.md — ADR for multi-IDE campsite enforcement
 */
import { resolve as pathResolve, join as pathJoin } from 'node:path';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { CampsiteEngine, resolveConfig } from '#src/index';

/**
 * Host-specific response schemas.
 *
 * Each schema is keyed by mode and describes the valid output shape.
 * `decision` enums list the only values Claude / Cursor accept in
 * that position.  The `pretool` entry validates `hookSpecificOutput`
 * nesting.  `null` means passthrough (no validation).
 *
 * Claude's top-level decision pattern: the only valid value is
 * `"block"`.  To allow, omit the field entirely.  Cursor never uses
 * `decision` — it uses `followup_message` for stop gating.
 *
 * @see https://code.claude.com/docs/en/hooks — JSON output section
 */
const SCHEMAS = {
  claude: {
    'session-start': { decision: null },
    pretool: {
      decision: null,
      hookSpecificOutput: {
        hookEventName: ['PreToolUse'],
        permissionDecision: ['allow', 'deny', 'ask', 'defer']
      }
    },
    'tool-success': { decision: null },
    'tool-failure': { decision: null },
    stop: { decision: ['block'] },
    'subagent-stop': { decision: ['block'] },
    resolve: null
  },
  cursor: {
    'session-start': { decision: null },
    'tool-success': { decision: null },
    'tool-failure': { decision: null },
    'agent-response': { decision: null },
    'agent-thought': { decision: null },
    stop: { decision: null, followup_message: 'string' },
    resolve: null
  }
};

const { host, repo, mode } = args();
const input = await read();
const config = resolveConfig(repo);
const statePath = CampsiteEngine.resolve(input, config.state);
const engine = new CampsiteEngine({ statePath, repo, config });
const verificationConfig = config.verification;

if (input.__parseError) {
  respond({ error: `invalid JSON: ${input.__parseError}` });
  process.exit(0);
}

switch (mode) {
  case 'session-start':
    await sessionStart();
    break;
  case 'tool-success':
    await toolSuccess(input);
    break;
  case 'tool-failure':
    await toolFailure(input);
    break;
  case 'agent-response':
    await agentResponse(input);
    break;
  case 'agent-thought':
    await agentThought(input);
    break;
  case 'stop':
    await stop(input);
    break;
  case 'subagent-stop':
    await subagentStop(input);
    break;
  case 'pretool':
    pretool(input);
    break;
  case 'resolve':
    await resolve(input);
    break;
  default:
    respond({});
}

// ── Lifecycle handlers ────────────────────────────────────────────

/**
 * Initialize campsite tracking state.
 *
 * Resets state for new sessions (`startup`, `clear`, `compact`) and
 * preserves it for resumed sessions so findings from the prior turn
 * survive the continuation.
 */
async function sessionStart() {
  const source = input.source ?? 'startup';

  if (source !== 'resume') {
    await engine.start();
  }

  await engine.setNonce(randomUUID());
  respond({});
}

/**
 * Track verification outcomes from successful shell tool executions.
 *
 * A non-zero exit code is still a tool "success" (the tool ran the
 * command), but the verification failed.
 *
 * @param {object} payload - Normalized hook payload.
 */
async function toolSuccess(payload) {
  const command = payload.tool_input?.command ?? '';

  if (!isVerification(command)) {
    respond({});
    return;
  }

  const output = host === 'claude' ? payload.tool_response : payload.tool_output;
  const code = exitcode(output);
  const successCodes = verificationConfig.successExitCodes ?? [0];

  if (successCodes.includes(code)) {
    await engine.pass(command);
    await writeProof(command, code, output);
    respond({});
    return;
  }

  await engine.fail(payload, command, 'non_zero_exit', `verification exited ${code}`);
  respond({});
}

/**
 * Write a hook-produced proof artifact and register it in session
 * state so the resolver can verify the artifact was not fabricated.
 *
 * @param {string} command - Verification command that passed.
 * @param {number} code - Exit code (always a success code here).
 * @param {string} [output] - Raw tool output for the proof record.
 * @returns {Promise<void>}
 */
async function writeProof(command, code, output) {
  if (!statePath) return;

  const dir = config.state?.directory ?? pathResolve(statePath, '..');
  const id = randomUUID().slice(0, 8);
  const path = pathJoin(dir, `campsite-proof-${id}.json`);

  const artifact = {
    command,
    exitCode: code,
    timestamp: Date.now(),
    output: output ?? null
  };

  await writeFile(path, JSON.stringify(artifact, null, 2), 'utf8');
  await engine.register(path);
}

/**
 * Record unresolved state when a verification command fails at the
 * tool level (timeout, permission denied, crash).
 *
 * Claude delivers failures with a top-level `error` string and no
 * `failure_type`; Cursor uses `failure_type` and `error_message`.
 *
 * @param {object} payload - Normalized hook payload.
 */
async function toolFailure(payload) {
  const command = payload.tool_input?.command ?? '';
  const failureType = payload.failure_type ?? 'error';
  const ignored = verificationConfig.ignoredFailureTypes ?? ['permission_denied'];

  if (!isVerification(command) || ignored.includes(failureType)) {
    respond({});
    return;
  }

  const message = payload.error_message ?? payload.error ?? 'unknown verification failure';

  await engine.fail(payload, command, failureType, message);
  respond({});
}

/**
 * Scan the agent's response text for dismissive language.
 *
 * Only available in Cursor — Claude uses stop-time scanning instead.
 *
 * @param {object} payload - Hook payload with `text` field.
 */
async function agentResponse(payload) {
  await engine.observe(payload.text ?? '', 'response');
  respond({});
}

/**
 * Ignore agent thinking blocks.
 *
 * The campsite reminder should react to what the agent says or what
 * verification proves. Thinking-block scanning created noisy private-loop
 * findings, so this mode is retained only for backwards compatibility with
 * older hook configs.
 *
 * @param {object} payload - Hook payload with `text` field.
 */
async function agentThought(payload) {
  respond({});
}

/**
 * Evaluate stop-time gating and emit a continuation response if
 * unresolved findings remain.
 *
 * Claude scans the latest visible assistant response at stop time.
 * Older transcript history and thinking blocks are ignored to keep the
 * reminder bounded to the completion the user is about to see.
 *
 * Claude uses `stop_hook_active` to prevent infinite loops and
 * expects `{ decision }` responses instead of `{ followup_message }`.
 *
 * @param {object} payload - Hook payload.
 */
async function stop(payload) {
  if (host === 'cursor') {
    if (payload.status !== 'completed') {
      respond({});
      return;
    }
  }

  if (host === 'claude') {
    if (payload.stop_hook_active) {
      respond({});
      return;
    }

    await scanTranscript(payload.transcript_path);
  }

  const message = await engine.format();

  if (!message) {
    respond({});
    return;
  }

  if (host === 'claude') {
    respond({ decision: 'block', reason: message });
    return;
  }

  respond({ followup_message: message });
}

/**
 * Scan a subagent's transcript for dismissive language and gate its
 * completion.  Claude-only — Cursor has no subagent lifecycle hooks.
 *
 * Uses the same transcript scanning and block/allow pattern as the
 * main `Stop` handler.
 *
 * @param {object} payload - SubagentStop hook payload.
 */
async function subagentStop(payload) {
  if (payload.stop_hook_active) {
    respond({});
    return;
  }

  await scanTranscript(payload.agent_transcript_path);

  const message = await engine.format();

  if (!message) {
    respond({});
    return;
  }

  respond({ decision: 'block', reason: message });
}

/**
 * Block test commands with a descriptive reason instead of a silent
 * permission deny.  Matches the same patterns as Cursor's
 * `beforeShellExecution` matchers.
 *
 * Returns early with no output for non-test commands (pass-through).
 *
 * @param {object} payload - PreToolUse hook payload.
 */
function pretool(payload) {
  const command = payload.tool_input?.command ?? '';

  const testPatterns = [
    /(?<!["'])\b(pnpm|npm)\s+((-\w+|--[\w-]+)(\s+\S+|=\S+)?\s+)*(run\s+|exec\s+|dlx\s+)?(test|vitest)\b/,
    /\bnode\s+--test/,
    /(?<!["'])\b(npx|pnpx)\s+vitest/,
    /node_modules\/\.bin\/vitest\b/
  ];

  const campsitePatterns = [
    /node\s+.*(-e|--eval|--input-type)\b.*campsite-rule/,
    /node\s+.*campsite-rule.*(-e|--eval|--input-type)\b/,
    /(cat|head|tail|less|more|jq|python|node)\b.*\.local\/share\/campsite/,
    /import\s.*campsite-rule\/src/
  ];

  if (testPatterns.some(function match(p) { return p.test(command); })) {
    respond({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'Use `bin/onboard test` (or `bin/onboard run "pnpm --filter \'...\' test"` for a single package) instead — it sets up the required test environment.'
      }
    });
    return;
  }

  if (campsitePatterns.some(function match(p) { return p.test(command); })) {
    respond({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'Direct access to campsite-rule internals or the resolution ledger is not allowed. ' +
          'Read .agents/skills/campsite-rule/SKILL.md and follow the resolve workflow. ' +
          "Resolve findings via: echo '{...}' | node .agents/skills/campsite-rule/bin/hook.js --repo . resolve"
      }
    });
    return;
  }

  respond({});
}

/**
 * Explicitly resolve a finding by recording a proof in the ledger.
 *
 * Expected payload: `{ findingId, classification, evidence, ...proofFields }`.
 *
 * @param {object} payload - Resolution request.
 */
async function resolve(payload) {
  if (!payload.findingId) {
    respond({ error: 'missing findingId' });
    return;
  }

  const error = validateResolvePayload(payload, config.resolve);

  if (error) {
    respond({ error });
    return;
  }

  try {
    const nonce = await engine.nonce();

    await Promise.resolve(
      engine.resolve(payload.findingId, {
        classification: payload.classification,
        evidence: payload.evidence,
        subject: payload.subject,
        relatedFindingId: payload.relatedFindingId,
        verificationCommand: payload.verificationCommand,
        verificationEvidence: payload.verificationEvidence,
        testEvidence: payload.testEvidence,
        model: payload.model,
        effort: payload.effort,
        session: payload.session ?? payload.session_id ?? null,
        nonce
      })
    );
  } catch (error) {
    respond({ error: error.message });
    return;
  }

  respond({ resolved: payload.findingId });
}

// ── Transcript scanning ───────────────────────────────────────────

/**
 * Stream a Claude JSONL transcript and yield visible assistant text blocks.
 *
 * The JSONL format is undocumented but stable across observed sessions:
 * each line is a JSON object with a top-level `type` field.  Lines
 * with `type: "assistant"` contain `message.content`, an array that can
 * include `{ type: "text", text }`.
 *
 * Unparseable lines are silently skipped — a corrupt transcript should
 * not prevent stop-time gating from running.
 *
 * @param {string} path - Absolute path to the JSONL transcript.
 * @yields {{ text: string, source: 'response' }}
 */
async function* transcript(path) {
  let stream;

  try {
    stream = createReadStream(path, { encoding: 'utf8' });
  } catch {
    return;
  }

  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      let entry;

      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.type !== 'assistant') continue;

      const blocks = entry.message?.content;

      if (!Array.isArray(blocks)) continue;

      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          yield { text: block.text, source: 'response' };
        }
      }
    }
  } catch {
    // Read errors mid-stream are non-fatal.
  }
}

/**
 * Feed the latest visible assistant message from a JSONL transcript into the
 * campsite engine for observation.
 *
 * @param {string} path - Absolute path to the JSONL transcript.
 */
async function scanTranscript(path) {
  if (!path) return;

  let latest = null;

  for await (const { text, source } of transcript(path)) {
    latest = { text, source };
  }

  if (latest) {
    await engine.observe(latest.text, latest.source);
  }
}

// ── Adapter utilities ─────────────────────────────────────────────

/**
 * Parse CLI arguments into host, repo, and mode.
 *
 * Accepts `--host <cursor|claude>` and `--repo <path>` as named
 * flags.  The first positional argument is the mode.  Defaults to
 * `cursor` and `process.cwd()` when flags are omitted.
 *
 * @returns {{ host: string, repo: string, mode: string }}
 */
function args() {
  const argv = process.argv.slice(2);
  let host = 'cursor';
  let repo = process.cwd();
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--host' && i + 1 < argv.length) {
      host = argv[++i];
    } else if (argv[i] === '--repo' && i + 1 < argv.length) {
      repo = pathResolve(argv[++i]);
    } else {
      positional.push(argv[i]);
    }
  }

  return { host, repo, mode: positional[0] };
}

/**
 * Test whether a shell command is a project verification command.
 *
 * Builds regex patterns from the verification config rather than
 * using hardcoded patterns.  Splits on unquoted pipes and skips
 * data-source commands (`printf`, `echo`, `cat`) whose arguments
 * may contain verification-related text without being verification
 * commands themselves.
 *
 * Commands that pipe into the campsite hook are always excluded —
 * resolve payloads embed verification-related strings in JSON that
 * would otherwise false-match the patterns.
 *
 * The data-source check handles `cd ... &&` prefixes that IDEs add
 * when `working_directory` is set, so `cd /repo && printf '...'`
 * is correctly recognized as a data-source segment.
 *
 * @param {string} command - Shell command from the hook payload.
 * @returns {boolean} True for recognized verification commands.
 */
function isVerification(command) {
  if (/campsite-rule\/bin\/hook\.js/.test(command)) return false;

  const patterns = verificationConfig.patterns ?? [];
  const segments = command.split(/\s*\|\s*/);

  return segments.some(function check(segment) {
    const tail = segment.replace(/^.*?(?:&&|;)\s*/, '');

    if (/^\s*(printf|echo|cat)\s/.test(segment) || /^\s*(printf|echo|cat)\s/.test(tail)) {
      return false;
    }

    return patterns.some(function match(p) {
      return new RegExp(p).test(segment);
    });
  });
}

/**
 * Extract the exit code from a shell tool's JSON output.
 *
 * @param {string} output - JSON-stringified shell tool result.
 * @returns {number} Exit code, or -1 if unparseable.
 */
function exitcode(output) {
  if (!output) return -1;

  try {
    const parsed = JSON.parse(output);
    return parsed.exitCode ?? parsed.exit_code ?? -1;
  } catch {
    return -1;
  }
}

/**
 * Read and parse the JSON payload from stdin.
 *
 * @returns {Promise<object>} Parsed payload.
 */
async function read() {
  let text = '';

  for await (const chunk of process.stdin) {
    text += chunk;
  }

  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch (error) {
    return { __parseError: error.message };
  }
}

/**
 * Validate a response body against the host+mode schema.
 *
 * Checks three things:
 * 1. If `decision` is present, its value must be in the schema's
 *    enum (or the schema must explicitly allow decisions).
 * 2. If `hookSpecificOutput` is present, nested enum fields must
 *    match their declared values.
 * 3. Cursor responses must never contain Claude-specific fields.
 *
 * @param {object} body - Response about to be written.
 * @throws {Error} On schema violation.
 */
function validate(body) {
  const schema = SCHEMAS[host]?.[mode];

  if (schema === null || schema === undefined) return;

  if ('decision' in body) {
    const allowed = schema.decision;

    if (allowed === null) {
      throw new Error(
        `${host}:${mode} — unexpected "decision" field (value: "${body.decision}")`
      );
    }

    if (Array.isArray(allowed) && !allowed.includes(body.decision)) {
      throw new Error(
        `${host}:${mode} — invalid decision "${body.decision}", expected one of: ${allowed.join(', ')}`
      );
    }
  }

  if (body.hookSpecificOutput && schema.hookSpecificOutput) {
    const hso = body.hookSpecificOutput;
    const hsoSchema = schema.hookSpecificOutput;

    for (const [field, allowed] of Object.entries(hsoSchema)) {
      if (!(field in hso)) continue;

      if (Array.isArray(allowed) && !allowed.includes(hso[field])) {
        throw new Error(
          `${host}:${mode} — invalid hookSpecificOutput.${field} "${hso[field]}", expected one of: ${allowed.join(', ')}`
        );
      }
    }
  }
}

/**
 * Write the hook response to stdout after validating it against the
 * host-specific schema.
 *
 * Validation catches contract mismatches (like returning `"allow"`
 * where Claude expects `"block"` or an omitted field) at dev time
 * instead of at E2E time.  A validation failure throws, which
 * causes exit code 1 — Claude shows a non-blocking error notice.
 *
 * @param {object} body - Response payload.
 */
function respond(body) {
  validate(body);
  process.stdout.write(JSON.stringify(body));
}

/**
 * Validate the raw resolve payload coming from stdin.
 *
 * This is the structural gate: malformed or incomplete payloads should be
 * rejected before the engine even tries to resolve a finding.
 *
 * @param {object} payload - Parsed stdin JSON.
 * @param {object} resolveConfig - Resolve config slice.
 * @returns {string|null} Error message, or null when valid.
 */
function validateResolvePayload(payload, resolveConfig) {
  const required = ['findingId', 'classification', 'evidence'];

  if (resolveConfig?.requireModel ?? false) {
    required.push('model');
  }

  if (resolveConfig?.requireEffort ?? false) {
    required.push('effort');
  }

  const allowed = new Set([
    ...required,
    'model',
    'effort',
    'subject',
    'relatedFindingId',
    'verificationCommand',
    'verificationEvidence',
    'testEvidence',
    'session_id',
    'session'
  ]);
  const missing = [];

  for (const field of required) {
    if (!(field in payload)) {
      missing.push(field);
    }
  }

  if (missing.length > 0) {
    return `missing field(s): ${missing.join(', ')}`;
  }

  const wrong = required.filter(function field(name) {
    return typeof payload[name] !== 'string';
  });

  const optional = [
    'model',
    'effort',
    'subject',
    'relatedFindingId',
    'verificationCommand',
    'verificationEvidence',
    'testEvidence'
  ];
  const optionalWrong = optional.filter(function field(name) {
    return name in payload && payload[name] != null && typeof payload[name] !== 'string';
  });

  if (wrong.length > 0 || optionalWrong.length > 0) {
    return `invalid field type(s): ${[...wrong, ...optionalWrong].join(', ')}`;
  }

  const extra = Object.keys(payload).filter(function field(name) {
    return !allowed.has(name);
  });

  if (extra.length > 0) {
    return `unknown field(s): ${extra.join(', ')}`;
  }

  return null;
}
