/**
 * Plan ingest: turn a harness plan file into a `plan.ingested` event that **links + summarizes** the
 * plan rather than copying it (large-file rule, spec 09). The summary indexes the plan's structure;
 * the file itself stays on disk and is referenced by path.
 *
 * Per-harness format (real captures):
 *  - **Cursor** `.cursor/plans/*.plan.md` — YAML frontmatter (`name`, `overview`, `todos[]`,
 *    `isProject`). Parsed with `yaml`; only `{ id, status }` of each todo is indexed (not the body).
 *  - **Claude** `~/.claude/plans/*.md` — no frontmatter; a `# ` title + `## ` section headings.
 *
 * @module sumo/agent-artifacts/plan
 */

import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { join } from 'sumo/db/dedupe';

import { ok, fail, ArtifactRef } from './base/schema.mjs';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

/**
 * @typedef {{ append: (event: Record<string, unknown>) => Promise<unknown> }} PlanDb
 * @typedef {{ path?: string, harness: string, sessionId?: string, text?: string }} PlanInput
 */

/**
 * Summarize plan text into a small, durable index (no full bodies — keeps the summary light and free
 * of incidental secrets in plan prose).
 *
 * @access public
 * @param {string} text - Text used in the generated output.
 * @param {string} harness - Harness supplied to `parse`.
 * @returns {Record<string, unknown>} Structured output from `parse`.
 */
export function parse(text, harness) {
  const fm = FRONTMATTER_RE.exec(text);
  if (fm) {
    // Cursor (and any frontmatter plan): index the frontmatter fields.
    /** @type {Record<string, unknown>} */
    let meta = {};
    try {
      meta = parseYaml(fm[1]) ?? {};
    } catch {
      meta = {};
    }
    const todos = Array.isArray(meta.todos)
      ? meta.todos.map((t) => ({ ...(t?.id ? { id: t.id } : {}), ...(t?.status ? { status: t.status } : {}) }))
      : [];
    return {
      ...(meta.name ? { name: meta.name } : {}),
      // Bound the overview prose: the summary lands in an (unredacted) event payload, so we index a
      // short excerpt rather than copying arbitrary-length plan prose into the log (large-file rule).
      ...(meta.overview ? { overview: String(meta.overview).slice(0, 280) } : {}),
      ...(meta.isProject != null ? { isProject: meta.isProject } : {}), todos, todoCount: todos.length
    };
  }
  // Claude (and any heading-structured plan): title = first `# `, sections = `## ` headings.
  const lines = text.split('\n');
  const title = lines.find((l) => /^#\s+/.test(l))?.replace(/^#\s+/, '').trim();
  const sections = lines.filter((l) => /^##\s+/.test(l)).map((l) => l.replace(/^##\s+/, '').trim());
  return { harness, ...(title ? { title } : {}), sections, sectionCount: sections.length };
}

/**
 * Ingest a plan file → emit `plan.ingested` with a link (`planRef` = path) + summary. Never copies the
 * plan body into the event.
 *
 * @access public
 * @param {PlanDb} db - Database client used by the operation.
 * @param {PlanInput} opts - Plan location, harness id, and optional in-memory body.
 * @returns {Promise<import('./base/schema.mjs').Result>} Promise that resolves with the shared Result returned by `plan`.
 */
export async function plan(db, { path, harness, sessionId, text }) {
  let body = text;
  if (body === undefined) {
    try {
      body = await readFile(String(path), 'utf8');
    } catch (err) {
      return fail('SUMO_IO', `plan ingest: cannot read ${path}: ${err.message}`);
    }
  }
  const summary = parse(String(body), harness);
  await db.append({
    dedupe: join('plan', String(path)), type: 'plan.ingested', payload: { planRef: path, summary, ...(sessionId ? { sessionId } : {}) }, ext: {},
    ...(sessionId ? { sessionId } : {}), source: 'transcript', adapter: harness
  });
  return ok(ArtifactRef.parse({ kind: 'plan', path, summary }));
}
