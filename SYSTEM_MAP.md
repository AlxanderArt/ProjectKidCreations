# PKC SYSTEM MAP

This is the contract between layers. If you're touching this repo, know what
sits above and below it.

## System Layer
- **AlxanderArt/PKCDesignSystem** — tokens, brand language, figma-spec, assets.
  Consumed by every product. Versioned releases (semver). Slow cadence.

## Product Layer
- **AlxanderArt/ProjectKidCreations** — onboarding form (live), future product
  surfaces. Consumes tokens from PKCDesignSystem. Continuous deploy. Fast cadence.

## Orchestration Layer
- **n8n PK Creations Workflow** (Sovereign+ v2.7) at
  https://n8n.srv1109728.hstgr.cloud
  - Health monitoring + auto-heal every 3h (`0 */3 * * *`)
  - Intelligence analysis daily at 06:02 (`2 6 * * *`, jittered)
  - Maintenance archive Sundays 03:00 (`0 3 * * 0`)
  - Master workflow ID: `s8on2D5ey4oNHNLp`
  - Public chat URL: `https://n8n.srv1109728.hstgr.cloud/webhook/47d8060b-6483-4634-9f59-ba8c7ea1e35b/chat`
  - 6 capability tools + API workflow (`AGpuS5AdtAKCI6lP`) + Archive workflow (`N53l5Ld6jds85g57`)

## Intelligence Layer (v2.5+)
- **Decision Engine + Adaptive Planner** (deterministic, temp=0) inside
  PKCW — Plan and Execute. Every decision recorded in a Decision Trace.
- **Execution Memory** (Config tab on the registry sheet) — scored
  successful_sequences, failed_sequences, execution_history_patterns.
- **`analyze_system_state` tool** — overall_health, trend, top_risk,
  critical_issues, recommended_actions.

## Reliability Layer (v2.7)
- Idempotency — request_id dedup (Config has salt; Execute Workspace
  enforcement deferred).
- State recovery — checkpoint after each step (deferred).
- Execution Isolation — no shared-state mutation until step succeeds.
- Planner Safety Rule — max 1 mutating action per workspace per goal.

## Observability Layer (v2.6+)
- Events log — every tool action emits a structured row (Execute / Monitor
  / Configure currently emit; others to be wired).
- Decision Trace — every plan returns reason for every drop/skip/reorder.

## Control Layer (v2.6+ extended v2.7)
- system_mode in Config: normal / safe / aggressive / incident.
- API endpoints (auth: x-pkc-key header):
  - `GET  /webhook/pkc/status`
  - `GET  /webhook/pkc/workspaces`
  - `GET  /webhook/pkc/events`
  - `POST /webhook/pkc/run`

## Maintenance Layer (v2.7)
- Weekly archive workflow rotates Events (>10k) + Runs (>5k) into archive tabs.

## State Layer
- **PK Creations Workspaces** sheet — registry. ID:
  `1Hc-EN05Duh1482t43YfQqXGwlDfoBcFXY57EoTiJXXI`. This sheet is a
  *decision system*, not just storage: health_score, priority_weight,
  needs_attention, capabilities, dependencies, last_plan_hash,
  last_decision_trace, event_count.
- **PKC Onboarding Submissions** sheet — operational data for onboarding
  submissions. ID: `1g93VRPcD5MLUbGQWEGiwdiB5COYlIGC2igAJkFPm9yU`.

## How they fit
- Tokens flow: PKCDesignSystem → ProjectKidCreations
- Orchestration flow: PK Creations Workflow → ProjectKidCreations workflows
- State flow: All workflows → PK Creations Workspaces (state) +
  PKC Onboarding Submissions (data)
- Intelligence flow: Execution Memory → Adaptive Planner → fewer LLM calls
- Audit flow: every tool action → Events tab

## When to update this file
Any time a layer is added, removed, or moved. Both repos must update in lockstep.
