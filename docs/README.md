# Service Documentation

Durable source-of-truth documentation for one service. Read the smallest relevant entry point for the task; do not require agents to read all docs before routine code changes.

## Routing

| Need                                               | Start here                                               |
| -------------------------------------------------- | -------------------------------------------------------- |
| Service purpose, owner, local setup, verification  | [../README.md](../README.md)                             |
| Product scope, users, requirements, acceptance     | [product/README.md](product/README.md)                   |
| Feature catalog and feature-scoped docs            | [features/README.md](features/README.md)                 |
| Service architecture and cross-cutting design      | [architecture/README.md](architecture/README.md)         |
| Architecture decisions                             | [architecture/adr/README.md](architecture/adr/README.md) |
| Technical designs for flows/modules                | [design/README.md](design/README.md)                     |
| API contracts, payloads, errors, OpenAPI           | [contracts/README.md](contracts/README.md)               |
| Build/test/lint/code style/documentation standards | [engineering/README.md](engineering/README.md)           |
| Setup, deploy, runtime, troubleshooting            | [operations/README.md](operations/README.md)             |
| Cross-cutting implementation strategy              | [plans/README.md](plans/README.md)                       |
| New document starting points                       | [templates/README.md](templates/README.md)               |
| Historical/superseded material                     | [archive/README.md](archive/README.md)                   |

## Source-of-truth hierarchy

1. Accepted ADRs for architecture decisions.
2. Product PRDs for product scope and requirements.
3. Feature docs for feature-scoped context, links, and rollout boundaries.
4. Architecture docs for service-wide structure and constraints.
5. Technical designs for specific flows/modules.
6. API contracts for interfaces and payloads.
7. Engineering and operations docs for implementation/runtime conventions.
8. Implementation plans for planned execution strategy.
9. Archive only for historical context.

## Design, plans, and Beads boundary

- `design/` answers: how a flow/module works and should continue working.
- `plans/` answers: how to implement a large change in phases.
- Beads track active task graph, status, dependencies, and execution units.
- Do not duplicate backlog/status in docs.
