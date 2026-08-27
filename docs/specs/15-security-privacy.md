# 15 — Security & Privacy

> Owning spec for redaction, retention, egress safety, marker trust boundaries, and local socket
> assumptions. This consolidates rules previously spread across storage, hooks, messenger, and
> installation specs.

## Scope

1.0 security is local-first and single-user. Sumo protects local records from accidental disclosure,
preserves auditability, and avoids pretending cryptographic guarantees exist where they do not.

Out of scope for 1.0: cryptographic marker signing, multi-user authorization, distributed daemon
coordination, hosted control planes, and autonomous knowledge-base gardening.

## Raw Payload Retention

- Normalized events go into the event log with adapter-specific detail in `ext`.
- Native raw hook payloads are stored behind `raw:` references, not embedded directly in event `ext`.
- Redaction happens before raw payload storage.
- Raw retention is a local durability/audit feature, not an egress source by default.
- TTL and future retention policy may delete raw records; normalized event envelopes remain the durable
  operational trail unless explicitly removed.

## Redaction Policy

- Redact at the boundary where untrusted or native payloads enter daemon storage.
- Preserve shape where possible so debugging remains useful without exposing secret values.
- Redaction must be additive and auditable: record redaction descriptors when offsets/kinds are known.
- Never place unredacted raw native payloads in plugin-visible normalized event `ext`.

## Egress To Messengers

Messenger egress is explicit: `reply`, `status`, `review`, `release`, and marker writes are effects.

Plugins must not forward raw payloads or transcripts to messengers by default. A workflow may send a
summary, status, review verdict, or release marker when that is the requested effect. If raw evidence
is needed later, it must be deliberately selected and scrubbed by that workflow.

## Marker Trust Boundary

GitHub markers are coordination evidence, not cryptographic proof. They are trusted only within the
messenger adapter's declared medium and author/identity checks.

For 1.0:

- Sumo-owned markers identify claim/review/release state.
- Foreign comments and malformed markers are preserved or ignored according to adapter rules; they do
  not become authoritative Sumo state.
- Cryptographic marker signing is deferred until explicitly chosen later.

## Local Socket Assumptions

The daemon sockets and pidfile are local user resources. They are created under `SUMO_HOME` with
owner-only permissions, and the daemon is not a hosted service.

Security assumptions:

- Same-user local processes can reach the daemon socket.
- Cross-user access is blocked by filesystem permissions.
- The daemon is the sole LevelDB owner and validates control-channel requests at the socket boundary.
- If these assumptions are insufficient for a deployment, that deployment is outside 1.0.

## Hook Safety

Native hooks are steering entrypoints. When steering cannot be reached or verified, behavior must be
honest:

- `steeringVerified:false` disables steering-dependent capabilities for that session.
- Verification failures surface `SUMO_STEERING_UNVERIFIED` or `SUMO_VERIFY_FAILED` diagnostics.
- Hook `--safety` decides fail-closed behavior when the daemon is unreachable; non-safety hooks fail
  open rather than crash the agent.

