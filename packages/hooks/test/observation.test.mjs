/**
 * Step 5 (spec 12): observation ingestion. PROVES (not asserts) that a hook-sourced tool event
 * collapses with the transcript-sourced one on the shared dedupe key, and that the raw native payload
 * is redacted + referenced by rawRef, never placed in evt.ext.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { observe } from '../src/index.mjs';
import { adapters } from 'sumo/harness';
import { adapters as transcriptAdapters } from 'sumo/transcript';
import { forEvent } from 'sumo/db/dedupe';
import { start } from 'sumo/db/daemon';

/** Implement mkHome. */ function mkHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-obs-')); }
// The real tool id present in the committed transcript fixture (claude-code/file/tools.jsonl).
const TOOL_ID = 'toolu_bdrk_018HwTPsJqLuSAM7ATHimb7V';

test('PROOF: hook PostToolUse and transcript tool event compute the SAME dedupe key (collapse)', /** Verify PROOF: hook PostToolUse and transcript tool event compute the SAME dedupe key (collapse). */ () => {
  // Transcript side: a tool_use block → session.tool with id = block.id.
  const parser = new transcriptAdapters['claude-code']();
  const frame = { type: 'assistant', session_id: 's', message: { id: 'msg_x', role: 'assistant', content: [
    { type: 'tool_use', id: TOOL_ID, name: 'Read', input: { file_path: '/work' } }
  ] } };
  const transcriptEvents = [...parser.stream(frame)];
  const tool = transcriptEvents.find(/** Find a matching item. */ (e) => e.type === 'session.tool');
  assert.ok(tool, 'transcript yields a session.tool');
  const transcriptKey = forEvent(tool, { position: 0 });

  // Hook side: PostToolUse with tool_use_id = the same id → session.tool with id = tool_use_id.
  const adapter = new adapters['claude-code']();
  const hookEvent = adapter.toObservation('PostToolUse', { session_id: 's', tool_name: 'Read', tool_use_id: TOOL_ID, tool_response: '260\t...' });
  const hookKey = forEvent(hookEvent, { position: 99 }); // position differs; natural id wins

  assert.equal(hookKey, `call:s:${TOOL_ID}`);
  assert.equal(hookKey, transcriptKey, 'hook + transcript tool events collapse on the same key');
});

test('redact-before-append: raw native payload is redacted under raw: + rawRef, never in evt.ext', /** Verify redact-before-append: raw native payload is redacted under raw: + rawRef, never in evt.ext. */ async () => {
  const home = mkHome();
  const daemon = await start({ home, idleShutdownMs: 0 });
  const db = daemon.inProcessClient();
  const adapter = new adapters['claude-code']();

  // A payload carrying a secret-shaped value in the tool input.
  const payload = { session_id: 'hook-session', tool_name: 'Bash', tool_use_id: TOOL_ID, tool_input: { command: 'curl -H "Authorization: Bearer sk-livesecret0123456789"' }, tool_response: 'ok' };
  const { dedupe, rawRef } = await observe({ adapter, harness: 'claude-code', nativeEvent: 'PostToolUse', payload, db });

  // the stored raw is redacted (the daemon redacts raw: keys on put)
  const storedRaw = await db.get(rawRef);
  assert.match(JSON.stringify(storedRaw), /REDACTED/);
  assert.doesNotMatch(JSON.stringify(storedRaw), /livesecret/);

  // the appended event references the raw, and carries NO raw native payload in ext
  const events = [];
  const unsub = await db.subscribe({ since: 0 }, /** Run the callback. */ (e) => events.push(e));
  const evt = events.find(/** Find a matching item. */ (e) => e.dedupe === dedupe);
  assert.ok(evt, 'event was appended');
  assert.equal(evt.rawRef, rawRef);
  assert.equal(evt.source, 'hook');
  assert.equal(JSON.stringify(evt.ext).includes('Authorization'), false, 'no raw native payload in ext');
  assert.deepEqual(evt.ext, {});
  unsub();

  await daemon.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('PROOF e2e: transcript tool + hook PostToolUse collapse to ONE enriched event', /** Verify PROOF e2e: transcript tool + hook PostToolUse collapse to ONE enriched event. */ async () => {
  const home = mkHome();
  const daemon = await start({ home, idleShutdownMs: 0 });
  const db = daemon.inProcessClient();

  // Transcript-sourced tool CALL (input), scoped to the native session the hook reports.
  await db.append({ dedupe: `call:hook-session:${TOOL_ID}`, type: 'session.tool', source: 'session', payload: { tool: { name: 'Read', input: { file_path: '/work' } } } });

  // Hook-sourced PostToolUse RESULT (output) via the observation path.
  const adapter = new adapters['claude-code']();
  await observe({ adapter, harness: 'claude-code', nativeEvent: 'PostToolUse', payload: { session_id: 'hook-session', tool_name: 'Read', tool_use_id: TOOL_ID, tool_response: 'file contents' }, db });

  // Exactly ONE session.tool event, enriched with BOTH input (call) and output (hook).
  const tools = [];
  for await (const [, e] of db.scan('evt:')) if (e.type === 'session.tool') tools.push(e);
  assert.equal(tools.length, 1, 'call + hook-result collapsed into one event');
  assert.equal(tools[0].payload.tool.input.file_path, '/work', 'kept the call input');
  assert.equal(tools[0].payload.tool.output, 'file contents', 'enriched with the hook output');

  await daemon.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('un-normalizable observation surfaces as a lossless passthrough (§3e), never dropped', /** Verify un-normalizable observation surfaces as a lossless passthrough (§3e), never dropped. */ async () => {
  const home = mkHome();
  const daemon = await start({ home, idleShutdownMs: 0 });
  const db = daemon.inProcessClient();
  const adapter = new adapters['claude-code']();

  const { type, dedupe } = await observe({ adapter, harness: 'claude-code', nativeEvent: 'SomeFutureHook', payload: { weird: true }, db });
  assert.equal(type, 'session.raw:claude-code.SomeFutureHook');

  const events = [];
  const unsub = await db.subscribe({ since: 0 }, /** Run the callback. */ (e) => events.push(e));
  assert.ok(events.find(/** Find a matching item. */ (e) => e.dedupe === dedupe), 'passthrough event was appended, not dropped');
  unsub();

  await daemon.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('id-less observations get distinct dedupe keys and raw payloads', /** Verify id-less observations get distinct dedupe keys and raw payloads. */ async () => {
  const home = mkHome();
  const daemon = await start({ home, idleShutdownMs: 0 });
  const db = daemon.inProcessClient();
  const adapter = new adapters.cursor();

  // Cursor shell hooks carry no stable tool id. Two identical commands are still two real executions,
  // so they must not collapse into one event or overwrite one raw payload.
  const payload = { hook_event_name: 'afterShellExecution', command: 'pwd', output: 'a' };
  const first = await observe({ adapter, harness: 'cursor', nativeEvent: 'afterShellExecution', payload, db });
  const second = await observe({ adapter, harness: 'cursor', nativeEvent: 'afterShellExecution', payload: { ...payload, output: 'b' }, db });
  assert.notEqual(first.dedupe, second.dedupe);
  assert.notEqual(first.rawRef, second.rawRef);

  const tools = [];
  for await (const [, event] of db.scan('evt:')) if (event.type === 'session.tool') tools.push(event);
  assert.equal(tools.length, 2);

  await daemon.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('copilot captured file-hook observations keep raw evidence without inventing a natural id', /** Verify copilot captured file-hook observations keep raw evidence without inventing a natural id. */ async () => {
  const home = mkHome();
  const daemon = await start({ home, idleShutdownMs: 0 });
  const db = daemon.inProcessClient();
  const adapter = new adapters.copilot();
  const payload = JSON.parse(fs.readFileSync(new URL('../../harness/test/fixtures/hook/copilot/postToolUse.json', import.meta.url), 'utf8'));

  const first = await observe({ adapter, harness: 'copilot', nativeEvent: 'postToolUse', payload, db });
  const second = await observe({ adapter, harness: 'copilot', nativeEvent: 'postToolUse', payload, db });
  assert.notEqual(first.dedupe, second.dedupe, 'Copilot hook payload carries no stable tool call id');
  assert.notEqual(first.rawRef, second.rawRef);

  const storedRaw = await db.get(first.rawRef);
  assert.equal(storedRaw.toolName, 'bash');
  assert.equal(storedRaw.sessionId, 'copilot-native-session');
  const tools = [];
  for await (const [, event] of db.scan('evt:')) if (event.type === 'session.tool') tools.push(event);
  assert.equal(tools.length, 2);
  assert.equal(tools[0].sessionId, 'copilot-native-session');
  assert.equal(tools[0].rawRef, first.rawRef);
  assert.deepEqual(tools[0].ext, {});

  await daemon.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('natural-id observations keep the transcript-collapse path', /** Verify natural-id observations keep the transcript-collapse path. */ async () => {
  const home = mkHome();
  const daemon = await start({ home, idleShutdownMs: 0 });
  const db = daemon.inProcessClient();
  const adapter = new adapters['claude-code']();

  const payload = { session_id: 'hook-session', tool_name: 'Read', tool_use_id: 'toolu_same', tool_response: 'x' };
  const first = await observe({ adapter, harness: 'claude-code', nativeEvent: 'PostToolUse', payload, db });
  const second = await observe({ adapter, harness: 'claude-code', nativeEvent: 'PostToolUse', payload, db });
  assert.equal(first.dedupe, second.dedupe);
  assert.equal(first.dedupe, 'call:hook-session:toolu_same');

  await daemon.close();
  fs.rmSync(home, { recursive: true, force: true });
});
