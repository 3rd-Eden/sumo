/**
 * One-shot Copilot fixture capture via Sumo's real harness path. It runs the `Copilot` adapter
 * against a real daemon, waits for the recorded `ses:` doc + `transcriptPath`, and then writes the
 * committed stream/file fixtures from that end-to-end run after scrubbing values.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { Copilot } from '../../harness/src/index.mjs';
import { assertAvailable, captureCopilotHarnessSession } from '../../harness/test/_live.mjs';
import { scrub } from './scrub.mjs';

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const FIX = path.join(DIR, 'fixtures', 'copilot');

/** Implement writeJsonl. */ function writeJsonl(file, rows) {
  fs.writeFileSync(file, rows.map(/** Map one item. */ (row) => JSON.stringify(scrub(row))).join('\n') + '\n');
}

/** Implement main. */ async function main() {
  const cfg = await assertAvailable(Copilot, process.env.SUMO_COPILOT_BIN ? { bin: process.env.SUMO_COPILOT_BIN } : {});
  const turn = await captureCopilotHarnessSession('Reply with exactly: HELLO', {
    ...cfg,
    /** Implement fileReady. */ fileReady(records) {
      return records.some(/** Test whether an item matches. */ (event) => event.type === 'assistant.message');
    }
  });
  const tool = await captureCopilotHarnessSession(
    'Use the shell tool to run exactly: printf sumo-tool-capture. Do not wrap it in markdown; just run the command.',
    {
      ...cfg,
      /** Implement stopWhen. */ stopWhen(event, events) {
        return event.type === 'session.tool' && Boolean(event.payload?.tool?.output)
          || event.type === 'session.ended'
          || event.type === 'session.dead'
          || events.some(/** Test whether an item matches. */ (e) => e.type === 'session.tool' && e.payload?.tool?.output);
      },
      /** Implement fileReady. */ fileReady(records) {
        return records.some(/** Test whether an item matches. */ (event) => event.type === 'tool.execution_complete');
      }
    }
  );

  try {
    writeJsonl(
      path.join(FIX, 'stream', 'turn.jsonl'),
      turn.rawEvents.filter(/** Select matching items. */ (event) => event.type === 'assistant.message' || event.type === 'session.idle')
    );
    writeJsonl(
      path.join(FIX, 'stream', 'tool.jsonl'),
      tool.rawEvents.filter(/** Select matching items. */ (event) => event.type === 'tool.execution_start' || event.type === 'tool.execution_complete')
    );
    writeJsonl(path.join(FIX, 'file', 'turn.jsonl'), turn.fileEvents);
    writeJsonl(
      path.join(FIX, 'file', 'tool.jsonl'),
      tool.fileEvents.filter(/** Select matching items. */ (event) => event.type === 'tool.execution_start' || event.type === 'tool.execution_complete')
    );
  } finally {
    await tool.cleanup();
    await turn.cleanup();
  }
}

if (process.env.SUMO_CAPTURE_COPILOT_FIXTURES === '1') {
  main().catch(/** Handle the expected rejection. */ (err) => {
    console.error(err);
    process.exit(1);
  });
}
