# Optional Swarm anti-pattern prompts

Use these checks in role prompts only when they fit your workflow:

- Foundation mismatch: implementation starts before the actual contract or invariant is known.
- Balloon pattern: one change inflates into unrelated refactors.
- Lock explosion: too many workers contend for the same write/test resources.
- Authority gradient: workers accept the root's phrasing instead of checking evidence.

These are examples, not built-in Swarm rules.
