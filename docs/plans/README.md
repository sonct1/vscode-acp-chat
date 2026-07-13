# Implementation Plans

Use this area for implementation strategy for large or cross-cutting changes: sequencing, phases, migration order, rollout plan, verification approach, risk management, and dependency management.

Typical files:

- `implement-<topic>.md`
- `migrate-<topic>.md`
- `refactor-<topic>.md`
- `rollout-<topic>.md`

Current plans:

- [Add Selection/File/Folder to Chat](./implement-add-to-chat-context.md) — add editor selection, Explorer file, and Explorer folder resources to the chat composer as mention chips.
- [Assistant Turn Navigation](./implement-assistant-turn-navigation.md) — jump quickly between completed assistant response turns in the chat transcript.
- [Prompt History Navigation](./implement-prompt-history-navigation.md) — use ArrowUp/ArrowDown in the prompt input to navigate user messages in the current chat session.
- [Searchable Model Picker](./implement-searchable-model-picker.md) — add search/filter support to the model selection dropdown.

Do not put long-lived technical design, API contracts, backlog items, active task status, or operational runbooks here. Use Beads for executable tasks and status.
