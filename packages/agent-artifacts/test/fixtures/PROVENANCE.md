# agent-artifacts fixtures — provenance

Capture-first (CONVENTIONS §3f). On-disk **transcript** records are NOT duplicated here — the tests
read the real, already-scrubbed captures committed under `packages/transcript/test/fixtures/<harness>/`
(see those PROVENANCE.md files for capture method/version). This package adds only the artifacts
unique to spec 09 (plans, config snapshots).

## Plans

- `cursor/plan/sample.plan.md` — real Cursor plan from `~/.cursor/plans/*.plan.md` on this machine
  (2026-06-22), **trimmed** (fewer todos, shortened body) to keep the fixture small. The frontmatter
  shape (`name` / `overview` / `todos[].{id,content,status}` / `isProject`) is verbatim from the real
  file. No secrets present.
- `claude-code/plan/sample.md` — real Claude plan from `~/.claude/plans/*.md` on this machine
  (2026-06-22), **trimmed** to its heading structure. Claude plans have **no** YAML frontmatter — a
  `# ` title plus `## ` section headings. No secrets present.

## Config (one per harness — adapter parity)

Each fixture is the **real config shape** for that harness, captured from this machine (2026-06-22),
with PII scrubbed (emails/names/IDs/project paths → placeholders) and a **planted token-shaped fake
secret** added so the redaction pipeline is genuinely exercised. Per §3f, a payload may test the
*pipeline* (here: storage-time redaction at the `raw:` boundary) — the real structure proves we handle
each harness's actual format; the planted secrets are not real keys (each marked `PLANTED`).

- `config/claude-code/settings.json` — real `~/.claude/settings.json` shape (JSON); planted
  `env.ANTHROPIC_AUTH_TOKEN` (`sk-ant-…`).
- `config/codex/config.toml` — real `~/.codex/config.toml` shape (TOML); planted provider `api_key`
  (`sk-…`).
- `config/cursor/cli-config.json` — real `~/.cursor/cli-config.json` shape (JSON), `authInfo` PII
  scrubbed; planted `authInfo.accessToken` (`ghp_…`).
- `config/opencode/opencode.json` — OpenCode config in the real `opencode.json` shape; planted
  `provider.anthropic.api_key` (`sk-ant-…`) and `env.OPENCODE_TOKEN` (`ghp_…`).
- `copilot/workspace.yaml` — real `~/.copilot/session-state/<id>/workspace.yaml` shape from GitHub
  Copilot CLI 1.0.65 on this machine (2026-06-29), with paths/repository scrubbed. Used to prove
  workspace-based correlation signals when the transcript head alone has no `session.start`.
