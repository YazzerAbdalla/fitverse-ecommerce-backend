---
name: spec-driven-development
description: Drive feature work via Spec Kit (specify → clarify → plan → tasks → implement → test → verify → converge). Use before implementing non-trivial features.
---

# Spec-Driven Development (Spec Kit)

This repo uses **GitHub Spec Kit** with the `opencode` integration. The
specification is the **source of truth**. Read [`AGENTS.md` §9](../../AGENTS.md)
and `.specify/` (templates, workflows, scripts).

## Core principle

```text
Specification → Clarification → Design → Plan → Implement → Test → Verify
```
Do **not** start coding a large feature before its specification is understood and
agreed.

## Commands (opencode slash commands in `.opencode/command/`)

```text
/speckit.constitution   # project constitution (once)
/speckit.specify        # write the specification
/speckit.clarify        # resolve ambiguities / edge cases
/speckit.plan           # technical design
/speckit.checklist      # quality checklist
/speckit.tasks          # task breakdown
/speckit.analyze        # analyze before implementation
/speckit.implement      # implement against the plan
/speckit.converge       # reconcile implementation with spec
```

## Workflow for a new feature

1. **Understand** — read `AGENTS.md`, relevant `skills/`, existing code, and any
   related spec. Inspect the actual implementation first.
2. **Clarify** — list ambiguous requirements, missing edge cases, business rules,
   security, data-consistency, and performance concerns. Do **not** invent
   business rules (e.g. reservation TTL, reserve-at-cart vs checkout). Raise them.
3. **Specify** — `/speckit.specify` to create/update the spec.
4. **Design** — `/speckit.plan`: decide API/DB/architecture changes, transactions,
   concurrency behavior, failure scenarios, tests.
5. **Plan** — `/speckit.tasks`: break into small, reviewable tasks.
6. **Implement** — per the approved plan, following `backend-development` and
   `database` skills.
7. **Verify** — `npm run lint`, `npm run build`, `npm run test`,
   `npm run test:e2e`.
8. **Review** — `/speckit.converge`: confirm the implementation matches the spec;
   update `docs/` and `docs/decisions/` for any new decision.

## Rules

- Spec Kit state lives in `.specify/`; the active feature is tracked in
  `.specify/feature.json`.
- When the spec and existing code/plan disagree, raise it as an open question
  rather than silently changing either.
- Prefer small changes; consider failure, concurrency, and DB consistency.
- Verify before declaring done — never claim tests passed without running them.
