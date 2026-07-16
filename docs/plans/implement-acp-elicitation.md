# Implementation Plan: Generic ACP Elicitation

| Attribute            | Value                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status               | Proposed                                                                                                                                                                             |
| Scope                | ACP `elicitation/create`, structured form UI, legacy and multi-session routing, background-session review, validation, tests, documentation, packaging                               |
| Primary feature path | `src/features/acp-elicitation/`                                                                                                                                                      |
| Protocol             | `@agentclientprotocol/sdk@1.2.1`; unstable ACP elicitation surface                                                                                                                   |
| References           | `src/acp/client.ts`, `src/views/chat.ts`, `src/features/multi-session/`, `src/features/register-host.ts`, `src/features/register-webview.ts`, `docs/architecture/acp-chat-layout.md` |

## Objective

Add a generic ACP client-side elicitation flow so an ACP agent can request structured input from the user and continue the same turn after receiving the response.

Primary use case:

```text
Claude Code AskUserQuestion
  -> ACP elicitation/create (form)
  -> VS Code ACP Chat renders a structured form
  -> user answers / declines / cancels
  -> CreateElicitationResponse returns to Claude
  -> Claude continues the same prompt turn
```

The implementation must be agent-neutral. It must not branch on `agentId === "claude-code"` or parse Claude-specific payloads.

## Scope decision

### Phase 1: form elicitation MVP

Implement and advertise:

```ts
clientCapabilities: {
  elicitation: {
    form: {},
  },
}
```

Support:

- session-scoped forms;
- tool-call-scoped forms;
- request-scoped forms that may occur before an ACP session exists;
- single-select, multi-select, text, number, integer and boolean fields;
- `email`, `uri`, `date` and `date-time` string formats;
- `accept`, `decline` and `cancel` responses;
- active and background multi-session requests;
- agent cancellation, session stop/close and extension disposal.

### Phase 2: URL elicitation

Do not advertise `url: {}` in Phase 1.

URL elicitation needs a separate lifecycle:

```text
elicitation/create(mode=url)
  -> user explicitly opens validated URL
  -> external browser flow
  -> agent sends elicitation/complete
  -> extension closes waiting UI
```

It also requires URL security rules, `elicitationId` correlation and completion notification handling. Advertising URL support before all of those exist would expose an incomplete capability.

### Non-goals for Phase 1

- Supporting vendor-specific question methods such as `opencode/question`, `gemini/requestUserInput` or `cursor/ask_question`.
- Refactoring the existing permission system into the elicitation feature.
- Persisting answers or forms across VS Code restart.
- Treating elicitation answers as ordinary chat prompts.
- Rendering custom/unknown elicitation modes or custom field types heuristically.
- Executing arbitrary agent-provided regular expressions.

## Current state

`ACPClient.connect()` currently advertises only filesystem and terminal capabilities:

```ts
clientCapabilities: {
  fs: {
    readTextFile: true,
    writeTextFile: true,
  },
  terminal: true,
}
```

It registers request handlers for permission, filesystem and terminal operations, but not:

- `elicitation/create`;
- `elicitation/complete`.

Consequences:

- `@agentclientprotocol/claude-agent-acp` sees no `elicitation.form` capability.
- Claude's adapter adds `AskUserQuestion` to its disabled tools.
- The model reports that `AskUserQuestion` is unavailable.
- No request reaches the Extension Host or webview.

## Protocol contract

SDK `1.2.1` exposes:

```ts
acp.methods.client.elicitation.create; // request
acp.methods.client.elicitation.complete; // notification
```

Form request:

```ts
{
  sessionId?: string;
  requestId?: string | number;
  toolCallId?: string | null;
  mode: "form";
  message: string;
  requestedSchema: {
    type?: "object";
    title?: string | null;
    description?: string | null;
    properties?: Record<string, ElicitationPropertySchema>;
    required?: string[] | null;
  };
}
```

Response:

```ts
{ action: "accept", content?: Record<string, ElicitationContentValue> | null }
{ action: "decline" }
{ action: "cancel" }
```

Allowed accepted content values are:

```ts
string | number | boolean | string[]
```

The feature must fail closed. It must never fabricate accepted content or copy the current permission fallback that auto-selects an allow option.

## Target architecture

```text
ACP agent / adapter
  │ elicitation/create
  ▼
ACPClient
  │ typed transport callback with params + requestId + AbortSignal
  ▼
src/features/acp-elicitation/host.ts
  │ owner-scoped pending interaction
  ├─ legacy owner
  └─ multi-session localSessionId owner
  ▼
Chat webview
  │ feature.acp-elicitation.state
  ▼
src/features/acp-elicitation/webview.ts
  │ normalized schema-driven form
  ▼
User Accept / Decline / Cancel
  │ feature.acp-elicitation.respond
  ▼
Host-side authoritative validation
  ▼
CreateElicitationResponse
  ▼
ACP agent continues the same turn
```

### Ownership rule

Route by the `ACPClient` runtime owner, not only by `params.sessionId`.

Reason: request-scoped elicitation may occur before `session/new`, so there may be no ACP session ID yet.

Owner mapping:

| Runtime                     | Owner ID                        |
| --------------------------- | ------------------------------- |
| Legacy singleton ACP client | `legacy`                        |
| Multi-session ACP client    | `ManagedSession.localSessionId` |

## Feature organization

Create:

```text
src/features/acp-elicitation/
├── host.ts
├── webview.ts
├── types.ts
├── form-schema.ts
├── styles.ts
└── index.ts

src/test/features/acp-elicitation.test.ts
```

Responsibilities:

| File             | Responsibility                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`       | Browser-safe DTOs and `feature.acp-elicitation.*` message contracts. Do not import `vscode` or ACP SDK runtime code.         |
| `form-schema.ts` | Convert SDK form schemas into a strict normalized model and validate submitted answers. Pure functions.                      |
| `host.ts`        | Owner registry, pending request lifecycle, response routing, cancellation and snapshot projection. May import ACP SDK types. |
| `webview.ts`     | Render the active form, collect values, show errors, manage focus and post responses. Must not import `vscode`.              |
| `styles.ts`      | Feature-local styles injected by `webview.ts`.                                                                               |
| `index.ts`       | Optional type-safe public exports without crossing host/browser environments.                                                |

Register through:

- `src/features/register-host.ts`;
- `src/features/register-webview.ts`.

Core files must contain only stable transport/dispatch integration points.

## Normalized form model

Do not send raw `_meta`, custom payloads or arbitrary JSON Schema into the webview.

Suggested DTO:

```ts
interface ElicitationFormView {
  interactionId: string;
  ownerId: string;
  message: string;
  title?: string;
  description?: string;
  toolCallId?: string;
  fields: ElicitationFieldView[];
  createdAt: number;
}

type ElicitationFieldView =
  | TextFieldView
  | SingleSelectFieldView
  | MultiSelectFieldView
  | NumberFieldView
  | BooleanFieldView;
```

Each field includes:

- stable property key;
- human-readable label;
- optional description;
- required flag;
- safe default value;
- normalized constraints relevant to the field type.

Webview-to-host response:

```ts
interface ElicitationRespondMessage {
  type: "feature.acp-elicitation.respond";
  ownerId: string;
  interactionId: string;
  action: "accept" | "decline" | "cancel";
  content?: Record<string, string | number | boolean | string[]>;
}
```

Never use ACP JSON-RPC request IDs as public webview correlation IDs. Generate opaque local IDs with `crypto.randomUUID()`.

## Form field mapping

| ACP schema                             | UI control                                                  |
| -------------------------------------- | ----------------------------------------------------------- |
| `string`                               | text input or textarea                                      |
| `string` + `enum`                      | single-select radio/listbox                                 |
| `string` + `oneOf`                     | titled single-select with descriptions                      |
| `string`, format `email`               | email input                                                 |
| `string`, format `uri`                 | URL text input; value is returned, not opened automatically |
| `string`, format `date`                | date input                                                  |
| `string`, format `date-time`           | datetime-local input with ISO conversion on submit          |
| `number`                               | number input                                                |
| `integer`                              | number input with integer validation                        |
| `boolean`                              | checkbox                                                    |
| `array` with string enum/`anyOf` items | multi-select checkboxes                                     |

Rendering policy:

- use radio controls for small single-select sets;
- use a listbox/select for long sets;
- use checkboxes for multi-select;
- render all agent text through `textContent`;
- do not use unsanitized `innerHTML`.

Claude's current `AskUserQuestion` adapter emits ordinary form fields, including separate custom-answer string fields. The generic renderer must support those without Claude-specific code.

## Schema validation

### Host-side normalization

Use SDK type guards where available:

- `CreateElicitationRequest.isForm()`;
- `ElicitationPropertySchema` guards;
- `MultiSelectItems` guards.

Do not import private SDK Zod modules and do not add a general JSON Schema engine.

Reject or cancel schemas that contain:

- an unknown form field type;
- malformed enum definitions;
- both `enum` and `oneOf` on one string field;
- required keys absent from `properties`;
- invalid defaults;
- contradictory constraints;
- unsafe or unsupported `pattern` constraints;
- resource limits exceeding configured constants.

### Suggested defensive limits

```ts
MAX_PENDING_PER_OWNER = 8;
MAX_FIELDS = 32;
MAX_OPTIONS_PER_FIELD = 100;
MAX_MESSAGE_CHARS = 8_000;
MAX_FIELD_LABEL_CHARS = 1_000;
MAX_STRING_ANSWER_CHARS = 16_000;
MAX_RESPONSE_BYTES = 64 * 1024;
```

The exact constants may be tuned during implementation, but explicit limits must exist before capability advertisement.

### Submission validation

Validate twice:

1. Webview validation for immediate UX.
2. Host validation as the authority because webview messages are untrusted.

Host rules:

- accept only known property keys;
- enforce required property presence;
- enforce primitive type and array type;
- enforce enum membership;
- enforce lengths, ranges and selection counts;
- require integers to be safe integers;
- omit absent optional fields rather than sending `null`;
- reject oversized response payloads;
- do not resolve the ACP request on invalid input; return field errors to the webview.

## Host coordinator lifecycle

Suggested API shape:

```ts
interface AcpElicitationHostFeature {
  createOwner(options: {
    ownerId: string;
    postState: (state: ElicitationOwnerState) => void;
    onPendingChanged: () => void;
  }): AcpElicitationOwner;

  handleMessage(message: unknown): Promise<boolean>;
  dispose(): void;
}

interface AcpElicitationOwner {
  handleRequest(
    context: ElicitationRequestContext
  ): Promise<CreateElicitationResponse>;
  getPendingViews(): ElicitationFormView[];
  cancelAll(): void;
  dispose(): void;
}
```

A pending record contains:

```ts
interface PendingElicitation {
  interactionId: string;
  ownerId: string;
  params: CreateElicitationRequest;
  normalizedForm: NormalizedElicitationForm;
  createdAt: number;
  state: "pending" | "resolving" | "resolved" | "aborted";
  resolve: (response: CreateElicitationResponse) => void;
  reject: (error: unknown) => void;
  abortCleanup: () => void;
}
```

Rules:

- one pending request is resolved exactly once;
- duplicate webview responses are ignored;
- owner mismatch is rejected;
- unknown interaction IDs are ignored and logged without content values;
- only the oldest pending request is rendered as active; later requests remain FIFO queued;
- pending content is memory-only and not stored in global state.

## ACPClient changes

Modify `src/acp/client.ts` minimally.

### Add typed callback

```ts
type ElicitationCallback = (context: {
  params: CreateElicitationRequest;
  requestId: JsonRpcId;
  signal: AbortSignal;
}) => Promise<CreateElicitationResponse>;
```

Use a single handler rather than a listener set because one inbound request must have one response owner.

### Register request handler

```ts
.onRequest(acp.methods.client.elicitation.create, (ctx) =>
  this.handleCreateElicitation(ctx)
)
```

Safe fallback when no feature handler exists:

```ts
{
  action: "cancel";
}
```

Never auto-accept.

### Advertise capability conditionally

The handler must be bound before `connect()`.

```ts
clientCapabilities: {
  fs: { ... },
  terminal: true,
  elicitation: this.elicitationHandler
    ? { form: {} }
    : undefined,
}
```

Do not advertise `url` in Phase 1.

### Preserve request cancellation

Pass the SDK handler's `AbortSignal` into the feature. Do not reduce the callback to `params` only.

## Legacy integration

In `ChatViewProvider`:

1. Create the legacy elicitation owner after host feature registration.
2. Bind `acpClient.setOnElicitationRequest(...)` before auto-connect.
3. Route `feature.acp-elicitation.respond` through the feature before the core switch.
4. Post owner state to the webview whenever the queue changes.
5. Cancel pending requests on:
   - stop;
   - new chat/agent replacement when the old runtime is disposed;
   - provider disposal;
   - connection error/disconnect.

Do not add a second queue directly to `ChatViewProvider`.

## Multi-session integration

### Managed session state

Add one elicitation owner handle per `ManagedSession`, or maintain owner state in the central feature keyed by `localSessionId`.

Add summary fields:

```ts
pendingElicitationCount: number;
```

Add status:

```ts
"awaiting_input";
```

Add aggregate:

```ts
awaitingInput: number;
```

Status priority:

```text
error
  > awaiting_input
  > awaiting_permission
  > running/loading/cancelling
  > idle/draft
```

### Active session

When an active session receives an elicitation:

- render the form immediately;
- preserve the current composer draft;
- keep Stop available;
- do not mutate `isGenerating` merely to show the form;
- do not insert the form into transcript history.

### Background session

When a background session receives an elicitation:

- queue it under the correct `localSessionId`;
- do not steal focus;
- update Session Manager status and count;
- show `Review input` action;
- activate and focus the owner session only when the user requests review.

### Snapshot contract

Extend active snapshot:

```ts
pendingElicitations?: ElicitationFormView[]
```

Pending elicitation state must be outside `transcript` to avoid duplicate replay.

During `applySnapshot()`:

1. reset the old active elicitation UI;
2. replay transcript;
3. apply metadata/context/diff;
4. replace elicitation state from `pendingElicitations`;
5. restore composer draft and scroll state.

### Session Manager

Extend `MultiSessionListItem` and manager UI:

- badge: `N input`;
- action: `Review input`;
- summary: `Input N` or include it in a generic waiting count;
- filter support for `awaiting_input`.

If both permission and elicitation are pending, show both badges and route each review action to the same owner session without resolving either automatically.

## Webview UX

Place a dedicated interaction panel above the composer, outside the transcript.

```text
┌──────────────────────────────────────────────────────┐
│ Input required                              1 of 1  │
│ Which environment should I target?                  │
│                                                      │
│ ( ) Development                                      │
│ ( ) Staging                                          │
│ ( ) Production                                       │
│ [Optional custom answer............................] │
│                                                      │
│ [Cancel] [Decline]                         [Submit]  │
└──────────────────────────────────────────────────────┘
│ Existing composer draft remains preserved            │
```

Behavior:

- first invalid field receives focus after submit;
- errors are summarized in an `aria-live` region;
- successful submit removes the form and restores focus appropriately;
- `Escape` maps to `cancel` only when focus is inside the elicitation panel and no inner popup is active;
- `Decline` is semantically different from `Cancel`;
- no automatic submission on ordinary Enter in multiline text;
- labels and descriptions are associated through `for`, `aria-describedby`, `fieldset` and `legend`;
- do not use the permission dialog's `setGenerating(true)` behavior.

Add a small generic composer interaction-lock API if needed. It must preserve draft HTML and keep Stop usable; it must not alter message-queue processing state.

## Cancellation and error semantics

| Event                             | Result                                                                  |
| --------------------------------- | ----------------------------------------------------------------------- |
| User submits valid form           | `{ action: "accept", content }`                                         |
| User explicitly declines          | `{ action: "decline" }`                                                 |
| User cancels/dismisses            | `{ action: "cancel" }`                                                  |
| Session stop                      | cancel every pending elicitation owned by that session                  |
| Session close/dispose             | cancel every pending elicitation owned by that session                  |
| Extension/provider disposal       | cancel all pending requests where transport is still available          |
| Agent sends JSON-RPC cancellation | remove UI and settle as request-cancelled; do not report user decline   |
| Connection loss                   | clear local pending UI/state; response delivery is no longer guaranteed |
| Invalid/unsupported schema        | fail closed with `cancel` and show a non-sensitive user-visible error   |
| Unknown elicitation mode          | preserve only for diagnostics, do not render, return `cancel`           |

Do not add a 60-second timeout. Elicitations may belong to background sessions and are explicitly designed to wait for user input. A timeout can be considered later as an opt-in policy.

## Security and privacy

- Treat all agent schema text and all webview responses as untrusted.
- Render labels/messages with `textContent`.
- Never log accepted field values.
- Never store submitted values in transcript, `globalState`, webview persisted state or telemetry.
- Do not send ACP `_meta` to the webview.
- Do not render unknown custom field types.
- Do not evaluate arbitrary `pattern` in Phase 1.
- Cap fields, options, text lengths, response size and pending requests.
- Preserve the current restrictive webview CSP.
- Use opaque local interaction IDs.
- Validate owner and interaction identity on every response.

## Phase 2: URL elicitation design

After form mode is stable, add:

```ts
elicitation: {
  form: {},
  url: {},
}
```

Required behavior:

- explicit user click; never auto-open;
- allow `https:` by default;
- optionally allow `http:` only for loopback hosts;
- reject embedded URL credentials;
- reject `javascript:`, `command:`, `vscode:`, `data:`, `file:` and unknown schemes;
- display origin without exposing sensitive query parameters in logs;
- open through Extension Host using a tightened reusable external-link validator;
- correlate by `(ownerId, elicitationId)`;
- wait for `elicitation/complete` notification;
- handle duplicate/out-of-order completion idempotently;
- clear URL waiting UI on decline, cancel, completion, close and disconnect.

Files added/extended in Phase 2:

- `src/acp/client.ts` notification handler;
- `src/features/acp-elicitation/host.ts` URL state machine;
- `src/features/acp-elicitation/webview.ts` URL waiting UI;
- shared safe URL opening from `src/features/clickable-resource-links/host.ts`.

## Applicability to built-in agents

Adding generic ACP form elicitation support is necessary for all agents, but it only activates automatically when the agent already emits standard `elicitation/create` requests.

Current public-source assessment as of July 2026:

| Built-in agent      | Standard ACP elicitation                                                               | Effect after Phase 1                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Claude Code         | Confirmed form and URL support                                                         | `AskUserQuestion` and form-based MCP elicitation become available automatically. URL waits for Phase 2. |
| Codex CLI           | Confirmed current adapter support for generic elicitation                              | Form requests work automatically when emitted. URL waits for Phase 2.                                   |
| Goose               | Confirmed form support in current ACP implementation                                   | Form requests work automatically when emitted.                                                          |
| Kimi CLI            | Elicitation exists on its unstable ACP surface                                         | Expected to work when its emitted schema matches SDK `1.2.1`; verify with integration test.             |
| Amp                 | Unknown/version-dependent                                                              | Client support becomes available, but agent behavior must be tested.                                    |
| Augment Code        | Unknown/version-dependent                                                              | Client support becomes available, but agent behavior must be tested.                                    |
| Mistral Vibe        | Unknown/version-dependent                                                              | Client support becomes available, but agent behavior must be tested.                                    |
| OpenHands           | Unknown as an ACP agent                                                                | Client support alone may not cause it to emit forms.                                                    |
| CodeBuddy Code      | Unknown/proprietary behavior                                                           | Client support alone may or may not enable forms.                                                       |
| OpenCode            | Uses a custom question extension in current public implementation                      | No automatic effect; needs an adapter bridge to standard elicitation.                                   |
| Gemini CLI          | Uses custom `gemini/requestUserInput` flow                                             | No automatic effect; needs custom-method support or upstream migration to ACP elicitation.              |
| Cursor              | Uses custom question methods                                                           | No automatic effect; needs custom-method support or upstream migration.                                 |
| Aider               | No confirmed standard elicitation support                                              | No automatic effect.                                                                                    |
| Qwen Code           | SDK/version work mentions elicitation, but agent-side emission is not confirmed        | No guaranteed automatic effect; test after agent upgrade.                                               |
| Kiro CLI            | No confirmed standard elicitation support                                              | No automatic effect.                                                                                    |
| Bundled Pi          | Current adapter supports select/confirm through permission; input/editor are cancelled | No automatic effect, but this repository can add a direct Pi-to-ACP elicitation bridge.                 |
| Bundled Antigravity | No confirmed standard elicitation support                                              | No automatic effect.                                                                                    |
| Bundled Swarm       | Currently proxies permissions, not elicitation                                         | Worker elicitation needs explicit proxy forwarding and owner correlation.                               |

### Recommended adapter follow-ups

After generic Phase 1:

1. **Bundled Pi**
   - map Pi `extension_ui_request` `select`, `confirm`, `input` and `editor` into form elicitation;
   - stop overloading permission for non-permission questions;
   - preserve cancellation semantics back to Pi RPC.

2. **Bundled Swarm**
   - proxy worker `elicitation/create` to the root client;
   - attach workflow/step/role metadata only on the host side;
   - route responses back to the exact worker session;
   - apply existing worker/session cleanup rules.

3. **Custom-protocol agents**
   - consider separate compatibility features only if upstream agents do not migrate to standard ACP elicitation;
   - do not place vendor-specific methods inside the generic feature.

## Implementation tasks

### Task 1 — Protocol seam in `ACPClient`

Files:

- `src/acp/client.ts`
- `src/test/client.test.ts` or a new focused client test

Changes:

- add typed elicitation callback;
- register `elicitation/create`;
- propagate request ID and abort signal;
- advertise `elicitation.form` only when handler is installed;
- return `cancel` when no handler exists;
- add capability and dispatch tests.

Acceptance:

- Claude adapter sees form capability during initialize;
- a mocked agent request reaches the callback;
- cancellation signal reaches the callback;
- no handler never causes acceptance.

### Task 2 — Form schema compiler and validator

Files:

- `src/features/acp-elicitation/form-schema.ts`
- `src/features/acp-elicitation/types.ts`
- `src/test/features/acp-elicitation.test.ts`

Changes:

- normalize all supported field kinds;
- validate defaults and constraints;
- enforce limits;
- validate submitted content;
- produce field-level error DTOs.

Acceptance:

- valid SDK form schemas normalize deterministically;
- malformed/custom/oversized schemas fail closed;
- tampered responses cannot resolve requests.

### Task 3 — Host coordinator

Files:

- `src/features/acp-elicitation/host.ts`
- `src/features/acp-elicitation/index.ts`
- `src/features/register-host.ts`

Changes:

- owner registry;
- pending FIFO state;
- response routing;
- abort handling;
- cancel/dispose handling;
- snapshot DTO projection.

Acceptance:

- each request resolves exactly once;
- owner mismatch and duplicate response are rejected;
- no answer values are logged or persisted.

### Task 4 — Webview form UI

Files:

- `src/features/acp-elicitation/webview.ts`
- `src/features/acp-elicitation/styles.ts`
- `src/features/register-webview.ts`
- minimal stable integration in `src/views/webview/main.ts` if required

Changes:

- render normalized fields;
- client-side validation;
- submit/decline/cancel;
- focus management and accessibility;
- interaction state replacement on session switch;
- feature-local styles.

Acceptance:

- keyboard-only operation works;
- all labels/errors are accessible;
- draft is preserved;
- `isGenerating` and message queue state are not corrupted.

### Task 5 — Legacy binding

Files:

- `src/views/chat.ts`
- focused legacy tests

Changes:

- create legacy owner;
- bind client callback before connect;
- dispatch response messages through feature;
- cancel on stop/dispose/runtime replacement;
- remove form UI when request settles.

Acceptance:

- a form request blocks and resumes the same turn;
- new chat/stop/dispose leaves no unresolved promise.

### Task 6 — Multi-session binding and manager state

Files:

- `src/features/multi-session/host.ts`
- `src/features/multi-session/contracts.ts`
- `src/features/multi-session/webview.ts`
- `src/features/multi-session/manager-webview.ts`
- `src/features/multi-session/manager-styles.ts` if needed
- `src/test/features/multi-session.test.ts`

Changes:

- owner per local session;
- `awaiting_input` status and counts;
- active immediate display;
- background queue without focus stealing;
- snapshot `pendingElicitations`;
- Review input action and badges;
- cancel on session stop/close/dispose.

Acceptance:

- background requests never render in another session;
- Review opens the correct owner session;
- response resolves the correct ACP runtime;
- snapshot replay displays each pending form once.

### Task 7 — Real-agent smoke tests

Claude Code test prompt:

```text
Before doing anything, use AskUserQuestion.
Ask exactly one single-choice question:
"Which environment should I target?"
Options: Development, Staging, Production.
Do not continue until the tool returns an answer.
After receiving the answer, repeat the selected value.
```

Expected:

- form appears in the extension;
- user selects `Staging`;
- no permission dialog is used;
- Claude continues in the same turn and repeats `Staging`.

Additional smoke tests:

- multi-select plus custom text with Claude;
- background session AskUserQuestion;
- cancel and decline paths;
- Codex/Goose/Kimi where installed and authenticated;
- request-scoped form fixture before `session/new`.

### Task 8 — Documentation and release verification

Update after implementation:

- `docs/features/feature-catalog.md`;
- `docs/architecture/acp-chat-layout.md`;
- this plan's status and completion notes;
- `README.md` only if user-facing feature summary needs updating.

Run:

```bash
npm run check-types
npx eslint <changed-typescript-files>
npm run compile-tests
# smallest focused tests first, then full relevant suite
npm run package
npx vsce package --out .tmp/vscode-acp-chat-elicitation.vsix
code --install-extension .tmp/vscode-acp-chat-elicitation.vsix --force
```

Remove the temporary VSIX after successful installation and run `Developer: Reload Window` before real-agent smoke tests.

## Test matrix

### Protocol

- capability omitted when handler absent;
- `form: {}` advertised when handler exists;
- request handler receives params, request ID and signal;
- unsupported/custom mode returns cancel;
- agent cancellation removes pending UI.

### Schema

- required/optional text;
- enum and titled `oneOf`;
- multi-select enum and titled `anyOf`;
- number boundaries;
- safe integer validation;
- boolean default;
- email/URI/date/date-time;
- invalid defaults;
- duplicate enum values;
- contradictory ranges;
- unknown property type;
- unsupported pattern;
- resource limits.

### Responses

- accept with validated content;
- decline without content;
- cancel without content;
- duplicate response;
- wrong owner;
- wrong field type;
- extra property injection;
- oversized payload.

### Lifecycle

- active legacy request;
- legacy stop/dispose;
- active multi-session request;
- background multi-session request;
- activation and snapshot replay;
- multiple FIFO requests;
- session close/dispose;
- connection loss;
- request before ACP session creation.

### Webview/accessibility

- labels and help text association;
- required state;
- error summary and first-error focus;
- keyboard selection;
- Escape cancel behavior;
- focus restoration;
- large font and narrow sidebar;
- no unsanitized HTML.

## Risks and mitigations

| Risk                                     | Impact                                          | Mitigation                                                                                                                |
| ---------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| ACP elicitation is unstable              | SDK changes can break types/contracts           | Isolate protocol-specific handling in `ACPClient` and `src/features/acp-elicitation/`; pin tests to SDK `1.2.1` behavior. |
| Capability advertised before UI is ready | Agent sends a request that cannot be rendered   | Bind feature handler before `connect()` and advertise capability conditionally.                                           |
| Background session deadlock              | Agent waits indefinitely without visible action | Manager badge, `awaiting_input` status and Review input action; no focus stealing.                                        |
| Webview response tampering               | Invalid values reach agent                      | Authoritative host-side schema validation.                                                                                |
| Sensitive values leak                    | Credentials/preferences persist in logs/state   | Do not log or persist form content; memory-only pending state.                                                            |
| Large/malicious schema freezes UI        | Extension/webview resource exhaustion           | Explicit field/options/text/payload/pending limits.                                                                       |
| Arbitrary regex causes ReDoS             | Extension or webview hang                       | Do not support `pattern` in Phase 1.                                                                                      |
| Elicitation state corrupts message queue | Incorrect composer/Stop behavior                | Separate interaction state; never toggle `isGenerating` for UI display.                                                   |
| Custom agent expects URL elicitation     | Auth flow unavailable in Phase 1                | Do not advertise URL; add it only in Phase 2.                                                                             |

## Definition of done

Phase 1 is complete when:

- `clientCapabilities.elicitation.form` is advertised only when the complete feature is bound;
- Claude Code `AskUserQuestion` works in the same turn;
- all supported form field types render and validate;
- accept, decline, cancel and agent-abort semantics are distinct;
- legacy and multi-session flows work;
- background requests are visible and reviewable without focus stealing;
- stop/close/dispose leaves no pending request;
- form values are not logged or persisted;
- focused automated tests pass;
- production bundle, VSIX packaging and forced local installation succeed;
- `docs/features/feature-catalog.md` and `docs/architecture/acp-chat-layout.md` match the implemented behavior.

## Recommended delivery order

```text
1. ACPClient protocol seam
2. Pure schema compiler/validator
3. Host coordinator
4. Webview form UI
5. Legacy integration
6. Multi-session/background integration
7. Claude real-agent smoke test
8. Other compatible agent smoke tests
9. Docs, package, install
10. Separate URL elicitation phase
11. Optional Pi and Swarm adapter bridges
```
