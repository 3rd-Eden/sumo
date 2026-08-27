# Codex control-side capture: server-initiated approval request

Real, captured (not mocked) — the JSON-RPC message `codex app-server` sends when it needs the client
to approve a sandbox-escaping command ( server-kind,  approvals).

- **CLI:** `codex app-server --stdio` — `codex-cli 0.140.0`
- **Captured:** 2026-06-22, on macOS (arm64).
- **How:** drive the app-server `initialize` → `thread/start` (`sandbox: "read-only"`,
  `approvalPolicy: "on-request"`) → `turn/start` with a prompt asking the agent to **write a file**
  (a read-only sandbox escape), which forces a server-initiated approval request. (A benign command
  like `echo` is auto-trusted and does NOT request approval — the action must exceed the policy.)

## Request shape (`approval-request.jsonl`)

A JSON-RPC **server-initiated request** (it has BOTH `method` and `id`):

- `method`: `item/commandExecution/requestApproval`
- `id`: the JSON-RPC id the client echoes in its response (here `0`)
- `params`: `threadId`, `turnId`, `itemId`, `reason`, `command`, `cwd`, `commandActions`,
  `proposedExecpolicyAmendment`, and `availableDecisions`.
- `availableDecisions`: a tagged union — string decisions (`"accept"`, `"cancel"`) and object
  decisions (`{ "acceptWithExecpolicyAmendment": { execpolicy_amendment: [...] } }`).

## Response shape (VERIFIED by observed effect)

The client replies to the request `id` with `result = { decision: <one of availableDecisions> }`:

```json
{ "jsonrpc": "2.0", "id": 0, "result": { "decision": "accept" } }
```

Confirmed empirically: replying `{ "decision": "accept" }` executed the write (file appeared);
replying `"accept"` (bare string) or `{ "decision": "approved" }` (invalid value) did NOT — proving
the exact accepted shape is `result.decision` set to an `availableDecisions` element. This is what
`CodexAppServer.respondApproval` / `frameApprovalResponse` produces.
