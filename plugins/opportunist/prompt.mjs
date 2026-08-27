/**
 * Prompt and result-block helpers for `opportunist`.
 *
 * @module sumo/plugins/opportunist/prompt
 */
/* eslint-disable jsdoc/match-description, jsdoc/require-param-description, jsdoc/require-returns-description */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderTemplate } from 'sumo/util';

/** Valid closure statuses for a repair finding. */
export const RESOLUTION_STATUSES = Object.freeze(['fixed', 'triaged', 'false-positive', 'bypassed']);

/** Valid triage actions for an opportunist finding. */
export const TRIAGE_ACTIONS = Object.freeze(['repair', 'triaged', 'false-positive', 'bypassed']);

const SUMO_CLI = fileURLToPath(new URL('../../packages/cli/src/cli.mjs', import.meta.url));
const REPAIR_TEMPLATE = new URL('./prompts/repair.md', import.meta.url);
const TRIAGE_TEMPLATE = new URL('./prompts/triage.md', import.meta.url);

/**
 * Build the dedicated triage-agent prompt.
 *
 * @access public
 * @param {{ findings: Array<Record<string, unknown>>, recentEvents?: Array<Record<string, unknown>>, cwd?: string, config?: Record<string, unknown>, templatePath?: string|null }} input
 * @returns {string} Prompt passed to `sumo.run`.
 */
export function triagePrompt({ findings, recentEvents = [], cwd, config = {}, templatePath = null }) {
  return renderTemplate(readTemplate(TRIAGE_TEMPLATE, templatePath), promptValues({
    findings,
    recentEvents,
    cwd,
    config
  }));
}

/**
 * Build the dedicated repair-agent prompt.
 *
 * @access public
 * @param {{ finding: Record<string, unknown>, recentEvents?: Array<Record<string, unknown>>, cwd?: string, config?: Record<string, unknown>, templatePath?: string|null, triageInstruction?: string }} input
 * @returns {string} Prompt passed to `sumo.run`.
 */
export function repairPrompt({ finding, recentEvents = [], cwd, config = {}, templatePath = null, triageInstruction = '' }) {
  return renderTemplate(readTemplate(REPAIR_TEMPLATE, templatePath), promptValues({
    finding,
    findings: [finding],
    recentEvents,
    cwd,
    config,
    triageInstruction
  }));
}

/**
 * Parse the triage agent's final decision block.
 *
 * @access public
 * @param {string} text - Final assistant text.
 * @returns {{ decisions: Array<{ id: string, action: string, reason: string, prompt?: string }> } | null} Parsed triage decisions.
 */
export function parseTriageBlock(text) {
  const match = /OPPORTUNIST_TRIAGE\s*([\s\S]*?)\s*END_OPPORTUNIST_TRIAGE/i.exec(text);
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.decisions)) return null;
  const decisions = [];
  for (const decision of parsed.decisions) {
    if (!decision || typeof decision !== 'object') return null;
    const record = /** @type {Record<string, unknown>} */ (decision);
    if (typeof record.id !== 'string' || !record.id) return null;
    if (typeof record.action !== 'string' || !TRIAGE_ACTIONS.includes(record.action)) return null;
    if (typeof record.reason !== 'string' || !record.reason) return null;
    if (record.action === 'repair' && (typeof record.prompt !== 'string' || !record.prompt)) return null;
    decisions.push({
      id: record.id,
      action: record.action,
      reason: record.reason,
      ...(typeof record.prompt === 'string' ? { prompt: record.prompt } : {})
    });
  }
  return { decisions };
}

/**
 * Parse the child agent's final result block.
 *
 * @access public
 * @param {string} text - Final assistant text.
 * @returns {{ status: string, evidence: string } | null} Parsed result or null when invalid.
 */
export function parseResultBlock(text) {
  const match = /OPPORTUNIST_RESULT\s*([\s\S]*?)\s*END_OPPORTUNIST_RESULT/i.exec(text);
  if (!match) return null;
  const body = match[1];
  const status = /^status:\s*(.+)$/im.exec(body)?.[1]?.trim();
  const evidence = /^evidence:\s*(.+)$/im.exec(body)?.[1]?.trim();
  if (!status || !evidence || !RESOLUTION_STATUSES.includes(status)) return null;
  return { status, evidence };
}

/**
 * Read a default or configured prompt template.
 *
 * @access private
 * @param {URL} defaultUrl
 * @param {string|null} templatePath
 * @returns {string}
 */
function readTemplate(defaultUrl, templatePath) {
  if (!templatePath) return fs.readFileSync(defaultUrl, 'utf8');
  const file = path.isAbsolute(templatePath) ? templatePath : path.resolve(process.cwd(), templatePath);
  return fs.readFileSync(file, 'utf8');
}

/**
 * Build shared prompt variables for template rendering.
 *
 * @access private
 * @param {{ finding?: Record<string, unknown>, findings: Array<Record<string, unknown>>, recentEvents: Array<Record<string, unknown>>, cwd?: string, config?: Record<string, unknown>, triageInstruction?: string }} input
 * @returns {Record<string, unknown>}
 */
function promptValues({ finding = {}, findings, recentEvents, cwd = '', config = {}, triageInstruction = '' }) {
  return {
    cwd,
    config,
    configJson: JSON.stringify(config, null, 2),
    finding,
    findingJson: JSON.stringify(finding, null, 2),
    findingSummary: formatFinding(finding),
    findings,
    findingsJson: JSON.stringify(findings, null, 2),
    findingsSummary: findings.map(formatFinding).join('\n') || '(no findings)',
    parentSessionId: String(finding.sessionId ?? findings[0]?.sessionId ?? ''),
    recentTrace: recentEvents.map(formatEvent).join('\n') || '(no recent events recorded)',
    sumo: {
      cli: SUMO_CLI,
      home: process.env.SUMO_HOME ?? ''
    },
    triage: {
      instruction: triageInstruction
    }
  };
}

/**
 * Render one finding line for prompt context.
 *
 * @access private
 * @param {Record<string, unknown>} finding
 * @returns {string}
 */
function formatFinding(finding) {
  const parts = [
    `id:${finding.id ?? ''}`,
    `kind:${finding.kind ?? ''}`,
    finding.command ? `command:${finding.command}` : '',
    finding.phrase ? `phrase:${finding.phrase}` : '',
    `snippet:${String(finding.snippet ?? '').slice(0, 500)}`
  ].filter(Boolean);
  return `- ${parts.join(' ')}`;
}

/**
 * Render one event line for a prompt.
 *
 * @access private
 * @param {Record<string, unknown>} event
 * @returns {string}
 */
function formatEvent(event) {
  const payload = event.payload && typeof event.payload === 'object' ? /** @type {Record<string, unknown>} */ (event.payload) : {};
  const text = typeof payload.text === 'string' ? payload.text : undefined;
  const tool = payload.tool && typeof payload.tool === 'object' ? /** @type {{ name?: unknown, input?: unknown, output?: unknown, exitCode?: unknown, status?: unknown }} */ (payload.tool) : undefined;
  const input = tool?.input && typeof tool.input === 'object' ? /** @type {{ command?: unknown }} */ (tool.input) : {};
  const command = typeof input.command === 'string' ? ` command:${input.command}` : '';
  const outcome = tool ? ` status:${String(tool.status ?? '')} exitCode:${String(tool.exitCode ?? '')}` : '';
  const output = typeof tool?.output === 'string' ? ` output:${tool.output.slice(0, 500)}` : '';
  const detail = text ? text.slice(0, 240) : typeof tool?.name === 'string' ? `tool:${tool.name}${command}${outcome}${output}` : '';
  return `- #${event.seq ?? '?'} ${event.type ?? 'event'} ${detail}`.trim();
}
