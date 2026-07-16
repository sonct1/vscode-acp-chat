import * as assert from "assert";
import { JSDOM } from "jsdom";
import type { CreateElicitationRequest } from "@agentclientprotocol/sdk";
import {
  compileElicitationForm,
  validateElicitationContent,
} from "../../features/acp-elicitation/form-schema";
import { registerAcpElicitationHostFeature } from "../../features/acp-elicitation/host";
import { registerAcpElicitationWebviewFeature } from "../../features/acp-elicitation/webview";
import type {
  ElicitationFieldView,
  ElicitationHostMessage,
} from "../../features/acp-elicitation/types";
import type { WebviewController } from "../../views/webview/main";

suite("acp elicitation", () => {
  test("normalizes supported schema and validates accepted content", () => {
    const form = compileElicitationForm(sampleRequest(), {
      interactionId: "interaction-1",
      ownerId: "owner-1",
      createdAt: 1,
    });

    assert.strictEqual(form.view.fields.length, 7);
    assert.deepStrictEqual(
      form.view.fields.map((field) => field.kind),
      ["text", "select", "multiselect", "number", "number", "boolean", "text"]
    );

    const result = validateElicitationContent(form, {
      name: "Ada",
      color: "red",
      tags: ["a"],
      score: 1.5,
      count: 2,
      enabled: false,
      meeting: "2026-07-16T10:20:30Z",
    });

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.content, {
      name: "Ada",
      color: "red",
      tags: ["a"],
      score: 1.5,
      count: 2,
      enabled: false,
      meeting: "2026-07-16T10:20:30Z",
    });
  });

  test("rejects invalid defaults, ranges, formats, duplicates, and limits", () => {
    assertInvalid({ name: { type: "string", pattern: ".*" } });
    assertInvalid({ color: { type: "string", enum: ["red", "red"] } });
    assertInvalid({
      color: { type: "string", enum: ["red"], default: "blue" },
    });
    assertInvalid({
      color: { type: "string", enum: ["x"], minLength: 2 },
    });
    assertInvalid({
      email: { type: "string", enum: ["not-email"], format: "email" },
    });
    assertInvalid({ n: { type: "number", minimum: 10, maximum: 1 } });
    assertInvalid({ n: { type: "integer", default: 1.5 } });
    assertInvalid({
      d: { type: "string", format: "date", default: "2026-02-31" },
    });
    assertInvalid({
      dt: {
        type: "string",
        format: "date-time",
        default: "2026-07-16T10:20:30",
      },
    });
    assertInvalid({
      dt: {
        type: "string",
        format: "date-time",
        default: "2026-02-31T10:20:30Z",
      },
    });
    assertInvalid({
      tags: {
        type: "array",
        items: { type: "string", enum: ["a", "b"] },
        default: ["a", "a"],
      },
    });
    assertInvalid({
      tags: {
        type: "array",
        items: { type: "string", enum: ["a", "b"] },
        minItems: 2,
        default: ["a"],
      },
    });
    assertInvalid({ ["k".repeat(257)]: { type: "string" } });
    assertInvalid({ x: { type: "string", title: "t".repeat(1001) } });
    assertInvalid({ x: { type: "string", enum: ["v".repeat(1001)] } });
  });

  test("host validates malformed/tampered messages without settling", async () => {
    const messages: Record<string, unknown>[] = [];
    const feature = registerAcpElicitationHostFeature();
    const owner = feature.createOwner({
      ownerId: "owner-1",
      postMessage: (message) => messages.push(message),
      postState: (state) =>
        messages.push({
          type: "state",
          pending: state.pendingElicitations.length,
        }),
    });
    const pending = owner.handleRequest({
      params: sampleRequest(),
      requestId: "rpc-1",
      signal: new AbortController().signal,
    });
    const interactionId = owner.getPendingViews()[0]?.interactionId;
    assert.ok(interactionId);

    assert.strictEqual(
      await feature.handleMessage({
        type: "feature.acp-elicitation.respond",
        ownerId: 1,
        interactionId,
        action: "accept",
        content: {},
      }),
      true
    );
    assert.strictEqual(owner.getPendingViews().length, 1);
    assert.strictEqual(
      await feature.handleMessage({
        type: "feature.acp-elicitation.respond",
        ownerId: "owner-2",
        interactionId,
        action: "cancel",
      }),
      false
    );
    assert.strictEqual(owner.getPendingViews().length, 1);
    assert.strictEqual(
      await feature.handleMessage({
        type: "feature.acp-elicitation.respond",
        ownerId: "owner-1",
        interactionId,
        action: "accept",
        content: { name: { bad: true } },
      }),
      true
    );
    assert.strictEqual(owner.getPendingViews().length, 1);

    const invalidResponse: ElicitationHostMessage = {
      type: "feature.acp-elicitation.respond",
      ownerId: "owner-1",
      interactionId,
      action: "accept",
      content: { name: "", color: "green" },
    };
    await feature.handleMessage(invalidResponse);
    assert.ok(
      messages.some(
        (message) => message.type === "feature.acp-elicitation.validation"
      )
    );
    assert.strictEqual(
      messages.filter((message) => message.type === "state").length,
      1
    );
    assert.strictEqual(owner.getPendingViews().length, 1);

    await feature.handleMessage({
      type: "feature.acp-elicitation.respond",
      ownerId: "owner-1",
      interactionId,
      action: "decline",
    });
    assert.deepStrictEqual(await pending, { action: "decline" });
    await feature.handleMessage({
      type: "feature.acp-elicitation.respond",
      ownerId: "owner-1",
      interactionId,
      action: "cancel",
    });
    assert.strictEqual(owner.getPendingViews().length, 0);
    feature.dispose();
  });

  test("FIFO pending views and abort/cancel/dispose settle pending requests", async () => {
    const feature = registerAcpElicitationHostFeature();
    const owner = feature.createOwner({
      ownerId: "owner-1",
      postMessage: () => {},
      postState: () => {},
    });
    const firstAbort = new AbortController();
    const first = owner.handleRequest({
      params: sampleRequest("first"),
      requestId: "r1",
      signal: firstAbort.signal,
    });
    const second = owner.handleRequest({
      params: sampleRequest("second"),
      requestId: "r2",
      signal: new AbortController().signal,
    });
    assert.deepStrictEqual(
      owner.getPendingViews().map((view) => view.message),
      ["first", "second"]
    );
    firstAbort.abort();
    assert.deepStrictEqual(await first, { action: "cancel" });
    assert.deepStrictEqual(
      owner.getPendingViews().map((view) => view.message),
      ["second"]
    );
    owner.cancelAll();
    assert.deepStrictEqual(await second, { action: "cancel" });

    const third = owner.handleRequest({
      params: sampleRequest("third"),
      requestId: "r3",
      signal: new AbortController().signal,
    });
    owner.dispose();
    assert.deepStrictEqual(await third, { action: "cancel" });
    feature.dispose();
  });

  test("webview renders FIFO count, accessible controls, tri-state boolean, ISO datetime response, and focus restore", () => {
    const dom = new JSDOM(
      '<!doctype html><html><head></head><body><button id="before">Before</button><div><div id="chat-input-area"><textarea id="chat-input"></textarea></div></div></body></html>',
      { pretendToBeVisual: true }
    );
    const posted: unknown[] = [];
    const controller = {
      getContext: () => ({
        doc: dom.window.document,
        win: dom.window,
        vscode: { postMessage: (message: unknown) => posted.push(message) },
      }),
    } as unknown as WebviewController;
    const before = dom.window.document.getElementById("before") as HTMLElement;
    before.focus();
    const feature = registerAcpElicitationWebviewFeature(controller);
    feature.handleMessage({
      type: "feature.acp-elicitation.show",
      ownerId: "owner-1",
      pendingElicitations: [
        view("one", sampleFields()),
        view("two", sampleFields()),
      ],
    } as never);

    assert.strictEqual(
      dom.window.document.querySelector(".acp-elicitation-queue")?.textContent,
      "1 of 2"
    );
    assert.ok(
      dom.window.document.querySelector("fieldset input[type='radio']")
    );
    const boolSelect = Array.from(
      dom.window.document.querySelectorAll("select")
    ).find((select) => select.textContent?.includes("Unset"));
    assert.ok(boolSelect);
    assert.ok(boolSelect.value.includes("unset"));
    assert.ok(dom.window.document.querySelector("[aria-describedby]"));

    (
      dom.window.document.querySelector(
        "input[type='text']"
      ) as HTMLInputElement
    ).value = "Ada";
    (
      dom.window.document.querySelector(
        "input[type='radio']"
      ) as HTMLInputElement
    ).checked = true;
    (
      dom.window.document.querySelector(
        "input[type='datetime-local']"
      ) as HTMLInputElement
    ).value = "2026-07-16T10:20";
    const submit = Array.from(
      dom.window.document.querySelectorAll("button")
    ).find((button) => button.textContent === "Submit") as HTMLButtonElement;
    submit.click();
    const response = posted[0] as {
      action: string;
      content: Record<string, unknown>;
    };
    assert.strictEqual(response.action, "accept");
    assert.ok(
      typeof response.content.when === "string" &&
        response.content.when.endsWith("Z")
    );
    assert.strictEqual(dom.window.document.activeElement, before);
  });

  test("required empty values are accepted when schema constraints allow them", () => {
    const form = compileElicitationForm(
      {
        mode: "form",
        requestId: "r1",
        message: "Empty values",
        requestedSchema: {
          type: "object",
          required: ["text", "choice", "items"],
          properties: {
            text: { type: "string" },
            choice: { type: "string", enum: [""] },
            items: {
              type: "array",
              items: { type: "string", enum: ["a"] },
              minItems: 0,
            },
          },
        },
      },
      { interactionId: "one", ownerId: "owner-1", createdAt: 1 }
    );
    assert.deepStrictEqual(
      validateElicitationContent(form, {
        text: "",
        choice: "",
        items: [],
      }),
      {
        ok: true,
        errors: {},
        content: { text: "", choice: "", items: [] },
      }
    );
  });

  test("webview renders option descriptions", () => {
    const dom = new JSDOM(
      '<!doctype html><html><head></head><body><div><div id="chat-input-area"><div id="input" tabindex="0"></div></div></div></body></html>',
      { pretendToBeVisual: true }
    );
    const controller = {
      getContext: () => ({
        doc: dom.window.document,
        win: dom.window,
        vscode: { postMessage: () => {} },
      }),
    } as unknown as WebviewController;
    const feature = registerAcpElicitationWebviewFeature(controller);
    feature.handleMessage({
      type: "feature.acp-elicitation.show",
      ownerId: "owner-1",
      pendingElicitations: [
        view("one", [
          {
            key: "choice",
            kind: "select",
            label: "Choice",
            required: true,
            options: [
              {
                value: "a",
                label: "Option A",
                description: "Description A",
              },
            ],
          },
          {
            key: "items",
            kind: "multiselect",
            label: "Items",
            required: false,
            options: [
              {
                value: "b",
                label: "Option B",
                description: "Description B",
              },
            ],
          },
        ]),
      ],
    } as never);
    assert.ok(dom.window.document.body.textContent?.includes("Description A"));
    assert.ok(dom.window.document.body.textContent?.includes("Description B"));
  });

  test("long select accepts an option equal to the internal unset marker", () => {
    const dom = new JSDOM(
      '<!doctype html><html><head></head><body><div><div id="chat-input-area"><div id="input" tabindex="0"></div></div></div></body></html>',
      { pretendToBeVisual: true }
    );
    const posted: unknown[] = [];
    const controller = {
      getContext: () => ({
        doc: dom.window.document,
        win: dom.window,
        vscode: {
          postMessage: (message: unknown) => posted.push(message),
        },
      }),
    } as unknown as WebviewController;
    const feature = registerAcpElicitationWebviewFeature(controller);
    const values = ["__acp_elicitation_unset__", "b", "c", "d", "e", "f", "g"];
    feature.handleMessage({
      type: "feature.acp-elicitation.show",
      ownerId: "owner-1",
      pendingElicitations: [
        view("one", [
          {
            key: "choice",
            kind: "select",
            label: "Choice",
            required: true,
            defaultValue: values[0],
            options: values.map((value) => ({ value, label: value })),
          },
        ]),
      ],
    } as never);
    const select = dom.window.document.querySelector(
      "select"
    ) as HTMLSelectElement;
    assert.strictEqual(select.selectedIndex, 1);
    const submit = Array.from(
      dom.window.document.querySelectorAll("button")
    ).find((button) => button.textContent === "Submit") as HTMLButtonElement;
    submit.click();
    assert.strictEqual(
      (posted[0] as { content: { choice: string } }).content.choice,
      values[0]
    );
  });

  test("webview preserves entered values when the same form queue grows", () => {
    const dom = new JSDOM(
      '<!doctype html><html><head></head><body><div><div id="chat-input-area"><div id="input" tabindex="0"></div></div></div></body></html>',
      { pretendToBeVisual: true }
    );
    const controller = {
      getContext: () => ({
        doc: dom.window.document,
        win: dom.window,
        vscode: { postMessage: () => {} },
      }),
    } as unknown as WebviewController;
    const feature = registerAcpElicitationWebviewFeature(controller);
    const first = view("one", sampleFields());
    feature.handleMessage({
      type: "feature.acp-elicitation.show",
      ownerId: "owner-1",
      pendingElicitations: [first],
    } as never);
    const name = dom.window.document.querySelector(
      "input[type='text']"
    ) as HTMLInputElement;
    name.value = "Ada";

    feature.handleMessage({
      type: "feature.acp-elicitation.show",
      ownerId: "owner-1",
      pendingElicitations: [first, view("two", sampleFields())],
    } as never);
    assert.strictEqual(name.isConnected, true);
    assert.strictEqual(name.value, "Ada");
    assert.strictEqual(
      dom.window.document.querySelector(".acp-elicitation-queue")?.textContent,
      "1 of 2"
    );
  });

  test("webview preserves date-time default seconds when submitted unchanged", () => {
    const dom = new JSDOM(
      '<!doctype html><html><head></head><body><div><div id="chat-input-area"><div id="input" tabindex="0"></div></div></div></body></html>',
      { pretendToBeVisual: true }
    );
    const posted: unknown[] = [];
    const controller = {
      getContext: () => ({
        doc: dom.window.document,
        win: dom.window,
        vscode: {
          postMessage: (message: unknown) => posted.push(message),
        },
      }),
    } as unknown as WebviewController;
    const feature = registerAcpElicitationWebviewFeature(controller);
    feature.handleMessage({
      type: "feature.acp-elicitation.show",
      ownerId: "owner-1",
      pendingElicitations: [
        view("one", [
          {
            key: "when",
            kind: "text",
            label: "When",
            required: true,
            format: "date-time",
            defaultValue: "2026-07-16T10:20:30Z",
          },
        ]),
      ],
    } as never);
    const input = dom.window.document.querySelector(
      "input[type='datetime-local']"
    ) as HTMLInputElement;
    assert.ok(input.value.includes(":30"));
    assert.strictEqual(input.step, "0.001");
    const submit = Array.from(
      dom.window.document.querySelectorAll("button")
    ).find((button) => button.textContent === "Submit") as HTMLButtonElement;
    submit.click();
    assert.strictEqual(
      (posted[0] as { content: { when: string } }).content.when,
      "2026-07-16T10:20:30.000Z"
    );
  });

  test("webview keeps colliding field keys isolated and focuses invalid choices", () => {
    const dom = new JSDOM(
      '<!doctype html><html><head></head><body><div><div id="chat-input-area"><div id="input" tabindex="0"></div></div></div></body></html>',
      { pretendToBeVisual: true }
    );
    const controller = {
      getContext: () => ({
        doc: dom.window.document,
        win: dom.window,
        vscode: { postMessage: () => {} },
      }),
    } as unknown as WebviewController;
    const feature = registerAcpElicitationWebviewFeature(controller);
    feature.handleMessage({
      type: "feature.acp-elicitation.show",
      ownerId: "owner-1",
      pendingElicitations: [
        view("one", [
          {
            key: "target/a",
            kind: "select",
            label: "First",
            required: true,
            options: [{ value: "first", label: "First" }],
          },
          {
            key: "target-a",
            kind: "select",
            label: "Second",
            required: true,
            options: [{ value: "second", label: "Second" }],
          },
        ]),
      ],
    } as never);

    const radioNames = Array.from(
      dom.window.document.querySelectorAll<HTMLInputElement>(
        "input[type='radio']"
      )
    ).map((input) => input.name);
    assert.strictEqual(new Set(radioNames).size, 2);

    feature.handleMessage({
      type: "feature.acp-elicitation.validation",
      ownerId: "owner-1",
      interactionId: "one",
      errors: { "target/a": "Choose a valid option." },
    } as never);
    assert.strictEqual(
      dom.window.document.activeElement,
      dom.window.document.querySelector("input[type='radio']")
    );
  });

  test("webview validation focuses the first error and clears back to the composer", () => {
    const dom = new JSDOM(
      '<!doctype html><html><head></head><body><div><div id="chat-input-area"><div id="input" tabindex="0"></div></div></div></body></html>',
      { pretendToBeVisual: true }
    );
    const controller = {
      getContext: () => ({
        doc: dom.window.document,
        win: dom.window,
        vscode: { postMessage: () => {} },
      }),
    } as unknown as WebviewController;
    const feature = registerAcpElicitationWebviewFeature(controller);
    const staleFocus = dom.window.document.createElement("button");
    staleFocus.textContent = "Temporary";
    dom.window.document.body.appendChild(staleFocus);
    staleFocus.focus();
    feature.handleMessage({
      type: "feature.acp-elicitation.show",
      ownerId: "owner-1",
      pendingElicitations: [view("one", sampleFields())],
    } as never);
    feature.handleMessage({
      type: "feature.acp-elicitation.validation",
      ownerId: "owner-1",
      interactionId: "one",
      errors: { name: "This field is required.", _form: "Check the form." },
    } as never);

    const name = dom.window.document.querySelector(
      "input[type='text']"
    ) as HTMLInputElement;
    assert.strictEqual(dom.window.document.activeElement, name);
    staleFocus.remove();
    assert.ok(
      dom.window.document
        .querySelector(".acp-elicitation-error-summary")
        ?.textContent?.includes("Check the form.")
    );

    feature.handleMessage({
      type: "feature.acp-elicitation.show",
      ownerId: "owner-1",
      pendingElicitations: [],
    } as never);
    assert.strictEqual(
      dom.window.document.activeElement,
      dom.window.document.getElementById("input")
    );
  });
});

function assertInvalid(properties: Record<string, unknown>): void {
  assert.throws(() =>
    compileElicitationForm(
      {
        mode: "form",
        requestId: "r1",
        message: "Need input",
        requestedSchema: { type: "object", properties },
      } as CreateElicitationRequest,
      { interactionId: "interaction-1", ownerId: "owner-1", createdAt: 1 }
    )
  );
}

function sampleRequest(message = "Need input"): CreateElicitationRequest {
  return {
    mode: "form",
    requestId: "request-1",
    message,
    requestedSchema: {
      type: "object",
      required: ["name", "color"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 20 },
        color: { type: "string", enum: ["red", "blue"] },
        tags: {
          type: "array",
          items: { type: "string", enum: ["a", "b"] },
          maxItems: 2,
        },
        score: { type: "number", minimum: 0, maximum: 10 },
        count: { type: "integer", minimum: 0 },
        enabled: { type: "boolean" },
        meeting: { type: "string", format: "date-time" },
      },
    },
  };
}

function sampleFields(): ElicitationFieldView[] {
  return [
    { key: "name", kind: "text", label: "Name", required: true },
    {
      key: "color",
      kind: "select",
      label: "Color",
      required: true,
      options: [{ value: "red", label: "Red" }],
    },
    { key: "enabled", kind: "boolean", label: "Enabled", required: false },
    {
      key: "when",
      kind: "text",
      label: "When",
      required: false,
      format: "date-time",
    },
  ];
}

function view(interactionId: string, fields: ElicitationFieldView[]) {
  return {
    interactionId,
    ownerId: "owner-1",
    message: interactionId,
    fields,
    createdAt: 1,
  };
}
