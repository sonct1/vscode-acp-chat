import { TextBlock } from "./text-block";
import { ThoughtBlock } from "./thought-block";
import { ToolBlock } from "./tool-block";
import type { BlockWidget } from "./block-widget";
import type { WebviewContext } from "../context";
import type { BlockType, Tool } from "../types";

/**
 * Manages the lifecycle of streaming content blocks within the current
 * assistant message. Tracks active block, block list, and tool-block
 * lookup by tool call id.
 *
 * Extracted from the controller so that block state transitions are
 * independent of message routing and DOM event handling.
 */
export class BlockManager {
  private blocks: BlockWidget[] = [];
  private activeBlock: BlockWidget | null = null;
  private toolBlockById = new Map<string, ToolBlock>();

  constructor(private ctx: WebviewContext) {}

  /** Return the list of all blocks for the current assistant message. */
  getBlocks(): readonly BlockWidget[] {
    return this.blocks;
  }

  /** Return the currently active block (if any). */
  getActiveBlock(): BlockWidget | null {
    return this.activeBlock;
  }

  /** Clear the active block reference without finalizing. */
  clearActiveBlock(): void {
    this.activeBlock = null;
  }

  /** Look up a tool block by its tool call id. */
  getToolBlock(toolCallId: string): ToolBlock | undefined {
    return this.toolBlockById.get(toolCallId);
  }

  /**
   * Ensure the active block is of the given type. If the active block
   * already matches, return it. Otherwise finalize the old block and
   * create a new one.
   */
  ensureBlock(
    type: BlockType,
    parentEl: HTMLElement,
    typingIndicatorEl: HTMLElement | null,
    toolId?: string
  ): BlockWidget {
    if (this.activeBlock && this.activeBlock.blockType === type) {
      if (
        type !== "tool" ||
        (this.activeBlock as ToolBlock).toolId === toolId
      ) {
        return this.activeBlock;
      }
    }

    // Finalize the old block before starting a new one.
    if (this.activeBlock) {
      this.finalizeBlock(this.activeBlock);
    }

    let block: BlockWidget;
    switch (type) {
      case "text":
        block = TextBlock.create(this.ctx);
        break;
      case "thought":
        block = ThoughtBlock.create(this.ctx);
        break;
      case "tool":
        block = ToolBlock.create(this.ctx, toolId!);
        break;
    }

    block.attachTo(parentEl, typingIndicatorEl);
    this.blocks.push(block);
    this.activeBlock = block;

    if (type === "tool" && toolId) {
      this.toolBlockById.set(toolId, block as ToolBlock);
    }

    return block;
  }

  /**
   * Ensure a tool block exists for the given tool call id. If one already
   * exists (by id lookup or in the block list), return it. Otherwise
   * finalize any active non-tool block and create a new tool block.
   */
  ensureToolBlock(
    toolCallId: string,
    parentEl: HTMLElement,
    typingIndicatorEl: HTMLElement | null
  ): ToolBlock {
    const existing =
      this.toolBlockById.get(toolCallId) ||
      (this.blocks.find(
        (b) => b.blockType === "tool" && (b as ToolBlock).toolId === toolCallId
      ) as ToolBlock | undefined);

    if (existing) {
      this.toolBlockById.set(toolCallId, existing);
      return existing;
    }

    // Finalize any active block before starting a new tool block.
    if (this.activeBlock) {
      this.finalizeBlock(this.activeBlock);
      this.activeBlock = null;
    }
    return this.ensureBlock(
      "tool",
      parentEl,
      typingIndicatorEl,
      toolCallId
    ) as ToolBlock;
  }

  /**
   * Finalize a specific block (collapse thoughts, close tools, etc.).
   */
  finalizeBlock(block: BlockWidget): void {
    block.finalize();
  }

  /**
   * Finalize all blocks and clear the active block reference.
   */
  finalizeAll(): void {
    for (const block of this.blocks) {
      this.finalizeBlock(block);
    }
    this.activeBlock = null;
  }

  /**
   * Remove stale running spinners from tool blocks and mark them completed.
   */
  clearStaleRunningToolIndicators(): void {
    for (const block of this.blocks) {
      if (block.blockType !== "tool") continue;
      const toolBlock = block as ToolBlock;
      const runningStatus = toolBlock.element.querySelector(
        ".tool-status.running"
      );
      if (!runningStatus) continue;

      runningStatus.remove();
      toolBlock.status = toolBlock.status || "completed";
      this.finalizeBlock(toolBlock);
    }
  }

  /**
   * Reset all tracking state (used when starting a new turn or clearing chat).
   */
  reset(): void {
    this.activeBlock = null;
    this.blocks = [];
    this.toolBlockById.clear();
  }

  /**
   * Build a snapshot of all tool blocks for the public getTools() API.
   */
  getToolsSnapshot(): Record<string, Tool> {
    const tools: Record<string, Tool> = {};
    for (const block of this.blocks) {
      if (block.blockType !== "tool" || !block.toolId) continue;
      const toolBlock = block as ToolBlock;
      const isRunning =
        toolBlock.element.querySelector(".tool-status.running") !== null;

      const detailInput = toolBlock.element.querySelector(".detail-input");
      const toolInput = toolBlock.element.querySelector(".tool-input");
      let inputText = "";

      if (detailInput) {
        const cmdDiv = detailInput.querySelector("div");
        if (cmdDiv && cmdDiv.textContent?.startsWith("$ ")) {
          inputText = cmdDiv.textContent.substring(2);
        } else {
          inputText = detailInput.textContent || "";
        }
      } else if (toolInput) {
        inputText = toolInput.textContent || "";
      }

      const input = inputText.startsWith("$ ")
        ? inputText.substring(2)
        : inputText.startsWith("$")
          ? inputText.substring(1).trim()
          : inputText;

      let name =
        toolBlock.element.querySelector(".tool-name")?.textContent || "Tool";
      if (name.includes(" | ")) {
        name = name.split(" | ")[0];
      }

      // Guarded by the continue above
      const tid = toolBlock.toolId as string;
      tools[tid] = {
        id: tid,
        name,
        input: input || null,
        output:
          toolBlock.element.querySelector(".tool-output")?.textContent || null,
        status: isRunning ? "running" : "completed",
        kind: toolBlock.kind,
      };
    }
    return tools;
  }
}
