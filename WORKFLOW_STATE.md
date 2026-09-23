# Workflow State — Multi-Agent Automated Software Factory

> **Factory pattern**: One orchestrator plans and validates; multiple isolated agents implement concurrently.
> Worktrees use `git worktree` for physical isolation. Planning must complete before parallel implementation.

## Global

- Factory Status: FACTORY_READY
- Planning Status: NOT_STARTED
- Active Agents: orchestrator, feature_alpha, feature_beta
- Repository: D:\Projects\mini-e-commerce
- Default Branch: master
- SpecKit Feature Dir: specs/011-async-events-notifications (current active; updated by orchestrator per feature)
- Last Updated: 2026-09-23

## Planning (Orchestrator Owns — Complete BEFORE Parallel Implementation)

- SPECIFY: NOT_STARTED
- CLARIFY: NOT_STARTED
- PLAN: NOT_STARTED
- TASKS: NOT_STARTED
- Planning Gate: NOT_EVALUATED
- PLANNING_COMPLETE: false

> **Critical rule**: Do NOT start Alpha/Beta until:
> `SPECIFY → CLARIFY → PLAN → TASKS` are all COMPLETE and gate `PASSED` → `PLANNING_COMPLETE=true`.
> Only then may `feature_alpha` and `feature_beta` start in parallel.

## Feature Alpha

- Agent: feature_alpha
- Profile: .opencode/agents/feature_alpha.md
- Branch: feature/alpha
- Worktree: worktrees/feature-alpha
- Base: master (be9a5ef)
- Phase: WAITING
- Status: WAITING_FOR_PLANNING
- Assigned Tasks: (populated after TASKS — e.g., T001, T002 for Alpha)
- Shared Contracts: (populated after PLAN — do not change without orchestrator)
- Agent Tests: NOT_RUN
- Orchestrator QA: NOT_STARTED
- Documentation: NOT_FINALIZED
- Push: NOT_READY
- Merge: NOT_READY
- Last Commit: —
- Notes: Isolated worktree. Never modify feature/beta worktree. Never merge into master.

## Feature Beta

- Agent: feature_beta
- Profile: .opencode/agents/feature_beta.md
- Branch: feature/beta
- Worktree: worktrees/feature-beta
- Base: master (be9a5ef)
- Phase: WAITING
- Status: WAITING_FOR_PLANNING
- Assigned Tasks: (populated after TASKS — e.g., T003, T004 for Beta)
- Shared Contracts: (populated after PLAN — do not change without orchestrator)
- Agent Tests: NOT_RUN
- Orchestrator QA: NOT_STARTED
- Documentation: NOT_FINALIZED
- Push: NOT_READY
- Merge: NOT_READY
- Last Commit: —
- Notes: Isolated worktree. Never modify feature/alpha worktree. Never merge into master.

## Orchestrator

- Agent: orchestrator
- Profile: .opencode/agents/orchestrator.md
- Worktree: . (repository root — main worktree, branch master)
- Mode: primary
- Responsibilities: SPECIFY → CLARIFY → PLAN → TASKS → gate → coordinate Alpha/Beta → QA each independently → polish docs → push → merge → integration tests

## Execution Order (enforced)

```
ORCHESTRATOR
  ↓ SPECIFY
  ↓ CLARIFY
  ↓ PLAN
  ↓ TASKS
  ↓ PLANNING_COMPLETE=true (gate PASSED)
  ↓
  ├──────────────┬──────────────┐
  ▼              ▼              │
FEATURE ALPHA  FEATURE BETA    │ (parallel, isolated worktrees)
IMPLEMENT      IMPLEMENT       │
TEST           TEST            │
COMMIT         COMMIT          │
  └──────┬──────┘              │
         ▼                     │
  READY_FOR_ORCHESTRATOR       │
         ↓                     │
  ORCHESTRATOR QA (per-agent, independent) 
  ├─ QA PASS → POLISH DOCS → PUSH → MERGE → INTEGRATION TESTS → DONE
  └─ QA FAIL → UPDATE PLAN/TASKS → SEND BACK → FIX → RETEST → QA
```

- Alpha finishing does NOT terminate Beta; Beta finishing does NOT terminate Alpha.
- Orchestrator processes each completed agent independently: `Alpha → QA` while `Beta → CONTINUES`.

## Final Completion Gate (per feature, before DONE)

```
✓ SPECIFY
✓ CLARIFY
✓ PLAN
✓ TASKS
✓ IMPLEMENT
✓ AGENT TESTS
✓ ORCHESTRATOR QA
✓ FINAL TESTS
✓ DOCUMENTATION UPDATED
✓ ACCEPTANCE CRITERIA VERIFIED
✓ COMMIT CREATED
✓ BRANCH PUSHED
✓ READY FOR MERGE
```

Only after this gate may orchestrator merge to master and run integration tests.

## Merge Strategy

```
feature branch → PUSH → ORCHESTRATOR → MASTER → MERGE → INTEGRATION TESTS
               (not solely because agent tests passed)
```

On integration failure:

```
MERGE → INTEGRATION FAILURE → STOP → DIAGNOSE → FIX FEATURE / UPDATE PLAN → RETEST
```

Never mark feature completed while integration is broken.

## Safety Rules (all agents)

- Never `git reset --hard` / `git clean -fd` / `git checkout -- .` on unknown/uncommitted work
- Never delete another agent's worktree
- Never force-push master
- Never commit secrets (.env git-ignored)
- Never claim test/QA passed without running/inspecting
- Never mark DONE merely because agent says so

## State Transitions (orchestrator updates this file)

| Transition | Who | Update |
|---|---|---|
| `FACTORY_READY → PLANNING` | orchestrator | Set `Factory Status: PLANNING`, start SPECIFY |
| `SPECIFY DONE` | orchestrator | `SPECIFY: COMPLETE`, keep `PLANNING_COMPLETE: false` |
| `CLARIFY DONE` | orchestrator | `CLARIFY: COMPLETE` |
| `PLAN DONE` | orchestrator | `PLAN: COMPLETE` |
| `TASKS DONE + gate PASSED` | orchestrator | `TASKS: COMPLETE`, `Planning Gate: PASSED`, `PLANNING_COMPLETE: true`, `Factory Status: IMPLEMENTATION`, Alpha/Beta `Phase: IMPLEMENT`, `Status: IN_PROGRESS` |
| `Alpha IMPLEMENT done` | feature_alpha | `Feature Alpha Status: READY_FOR_ORCHESTRATOR`, `Agent Tests: PASSED` |
| `Alpha QA PASS` | orchestrator | `Feature Alpha Orchestrator QA: PASSED`, then `Push/Merge` |
| `Beta likewise` | feature_beta/orchestrator | analogous |

## Current Next Action

- Orchestrator: Run `/speckit.specify` (or confirm existing `specs/011-async-events-notifications/spec.md`) then `/speckit.clarify` → `/speckit.plan` → `/speckit.tasks` for the next feature.
- Alpha/Beta: **WAITING** — do NOT implement until orchestrator sets `PLANNING_COMPLETE=true`.

## Verification Checklist (bootstrap)

- [x] Three agent profiles exist with valid YAML frontmatter (.opencode/agents/orchestrator.md, feature_alpha.md, feature_beta.md)
- [x] opencode.json uses provider opencode-zen, model opencode/gpt-5.1-codex, schema valid
- [x] WORKFLOW_STATE.md represents global + per-agent state, FACTORY_READY
- [x] Git branches feature/alpha and feature/beta exist with isolated worktrees worktrees/feature-alpha and worktrees/feature-beta
- [x] SpecKit config .specify/feature.json + .specify/templates intact
- [x] No existing user changes destroyed (git status clean before factory init)
- [x] opencode debug config resolves without schema errors
