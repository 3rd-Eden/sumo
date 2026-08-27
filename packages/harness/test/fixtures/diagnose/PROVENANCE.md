# Diagnose fixtures

Scrubbed real TUI pane captures for `diagnose()` tests.
Each file contains raw terminal/pane text that a harness shows when blocked on a dialog.

## Files needed (☐ = not yet captured)

### cursor/
- ☐ `working.txt` — normal working output (should diagnose as null)

### claude-code/
- ☐ `bypass-permissions-dialog.txt` — the yes/no bypass dialog
- ☐ `mcp-approval-dialog.txt` — "Do you want to proceed?" MCP approval prompt
- ☐ `working.txt` — normal working output (should diagnose as null)
- ☐ `welcome-banner.txt` — just the welcome banner (should diagnose as null)

### codex/
- ☐ `update-dialog.txt` — update available prompt ("Press enter to continue")
- ☐ `model-upgrade-dialog.txt` — model upgrade dialog with ↑/↓ navigation
- ☐ `invalid-model.txt` — stderr/output when invalid model is passed
- ☐ `working.txt` — normal working output (should diagnose as null)
- ☐ `banner.txt` — just the welcome banner (should diagnose as null)

## How to capture

Reproduce the dialog in a tmux pane, then:
  `tmux capture-pane -p -t <session>:<window>.<pane> > fixture.txt`

Scrub any personal data (API keys, usernames, paths) before committing.
