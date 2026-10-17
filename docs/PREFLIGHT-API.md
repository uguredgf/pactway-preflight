# Preflight HTTP API v1

This is a local, operator-run advisory API, not an order executor or a public multi-tenant brokerage service. All new reports are `LOCAL_ONLY`.

## Session and request boundary

Start with `GET /api/bootstrap`. The local server creates a visitor session and returns its CSRF token. Retain the session cookie and send `X-MG-CSRF`, `Content-Type: application/json`, and the exact allowed `Origin` on every POST. Browser requests should use same-origin credentials. Do not place OKX keys, wallet keys, passwords, or account configuration in these bodies.

Policies, checks, history, and downloads are scoped to that visitor session. Losing the cookie loses access to its records; knowing a record UUID does not grant access. Local anonymous sessions are not a production identity system. The server only listens on loopback. Configured invited HTTPS deployments retain their existing invitation and origin checks; this document does not claim public hosting is configured.

## Policy review and approval

`POST /api/preflight/policies` accepts exactly:

```json
{
  "instrument": "AVAX-USDT",
  "side": "buy",
  "tdMode": "cash",
  "ordType": "limit",
  "maxNotional": "25",
  "maxPrice": "25",
  "durationSeconds": "600"
}
```

Amounts are positive decimal strings with at most 12 integer and 8 fractional digits. Duration is a whole-number string in 60..3600 seconds. Notional excludes fees. The response contains the server-generated `id`, normalized `policy`, `policyHash`, `status`, `createdAtMs`, `validFromMs`, and `expiresAtMs`. The validity window starts when the draft is created, not when it is approved, and is not extended by retries.

Show the actual server response to the operator, then send `POST /api/preflight/policies/:id/approve`:

```json
{"policyHash":"<exact reviewed hash>","acknowledgement":true}
```

Approval is explicit and idempotent within the same validity window. It cannot change the policy. Editing requires a new policy. `GET /api/preflight/policies/:id` recovers the authoritative record after a lost response.

## One proposed order

`POST /api/preflight/checks` (direct, unchanged candidate) and `POST /api/preflight/agent-checks` (bounded agent review) accept exactly:

```json
{
  "policyId": "<approved policy UUID>",
  "policyHash": "<exact approved hash>",
  "candidate": {
    "instrument": "AVAX-USDT",
    "side": "buy",
    "tdMode": "cash",
    "ordType": "limit",
    "price": "24.80",
    "size": "0.4"
  },
  "clientRequestId": "<new UUID for this exact request>"
}
```

`price` is USDT per AVAX; `size` is AVAX. Unknown fields and invalid numeric syntax are rejected. Direct checks never round or change the candidate. An agent check may propose one explicit downward revision, with the same instrument/side/mode/type and neither price nor size above its initial value. It cannot change the approved policy. No implicit unit conversion occurs. Unsupported scope never opens a different trading workflow.

Persist the path, UUID and exact body **before sending**. An uncertain network result must be retried with the same path, UUID and body. The same request returns the same check; reusing its UUID with different input or across direct/agent paths conflicts. A new UUID means a new check and can consume model calls. Re-reading never consumes another model call.

An accepted request returns HTTP 202 with `{id,state,mode,createdAtMs,report}`; agent checks additionally expose `source:'AGENT'`. Both use `GET /api/preflight/checks/:id` until `COMPLETED`. Work is bounded; busy/capacity responses do not authorize blind retry loops. Server restart never automatically repeats a model or ATK call; interrupted work resolves without an ALLOW result.

## Sources and results

`GET /api/preflight/status` describes the fixed scope, readiness, limits, disabled Preflight order submission, and local-only publication. `agentAvailable` and `agentVersion` identify the new review capability. Clients must preserve compatibility with older status responses that omit these fields; they must not send agent requests to an older backend. Readiness is not a price snapshot or an execution permission.

Live checks require the UID-matched read-only ATK connection and local Ollama. The direct path retains its one-call planner, which only orders two reads and does not by itself demonstrate meaningful autonomy. The agent path reads `market_get_ticker` and `market_get_instruments`, independently evaluates the candidate, then asks the local model for `ACCEPT`, `REVISE` or `WAIT`. There are at most two review calls and one downward revision. A second review cannot revise again. An accepted candidate gets fresh reads and a final independent evaluation before completion. Model actions and the final verdict are separate; the model cannot override the evaluator or authorize an order.

The server, not the model or caller, fixes tool arguments and demo routing. Each response enters the durable registered stdio journal before evaluation. The source binding, capture, hash, and timing are checked. There is no caller-supplied live evidence endpoint and no generic tool-call proxy. Calls consume durable quota before dispatch, including calls whose responses fail. Model failure, invalid output, expired sessions or unavailable evidence do not trigger cloud/fixture fallback.

`ALLOW` means only the listed scoped checks passed. `BLOCK` means a known rule was breached. `INSUFFICIENT_DATA` means the available evidence could not complete the check. An external executor can ignore this advisory result. Balance, fees, portfolio, aggregate spend, native USD notional-limit conversion, order acceptance, and fills are outside scope.

`GET /api/preflight/history` returns bounded owner history. `GET /api/preflight/checks/:id/report` downloads a completed report. The report can be checked with:

```powershell
node scripts/verify-preflight-report.mjs "C:\path\report.json"
```

The verifier recalculates the scoped result and hash links. It does not establish authorship, independent time, actual exchange provenance, or an on-chain commitment. A report file is not an executable permission token.

## Explicit replay

`POST /api/preflight/examples/:name` accepts only `{"clientRequestId":"<UUID>"}`. Names are `within-limits`, `limit-breach`, and `stale-evidence`. Results are deterministic `REPLAY` reports with canned evidence, zero model calls, and no live ATK reads. They do not approve, edit, or replace the operator's policy. Treat replay separately from live readiness and acceptance.
