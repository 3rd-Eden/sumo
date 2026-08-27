---
name: workspace cache cleanup
overview: Add automatic garbage collection for workspace cache artifacts. Sessions, workspaces, and logs accumulate indefinitely; the plan adds age-based pruning to existing packages and triggers it at bootstrap time.
todos:
  - id: config-cleanup
    content: Add cleanup.retention and cleanup.autoprune to config defaults and schema
    status: completed
  - id: session-prune
    content: Add Storage.prune(maxAge) and Storage.remove(id) methods with tests
    status: completed
  - id: bootstrap-cleanup
    content: Wire cleanup.autoprune into bootstrap to call prune before session creation
    status: pending
isProject: false
---

# Workspace Cache Cleanup

## Problem

The workspace cache accumulates artifacts indefinitely.

## Plan

Age-based pruning wired into bootstrap.
