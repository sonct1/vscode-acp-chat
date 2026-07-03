import { escapeHtml } from "./html-utils";

const ANSI_FOREGROUND: Record<number, string> = {
  30: "ansi-black",
  31: "ansi-red",
  32: "ansi-green",
  33: "ansi-yellow",
  34: "ansi-blue",
  35: "ansi-magenta",
  36: "ansi-cyan",
  37: "ansi-white",
  90: "ansi-bright-black",
  91: "ansi-bright-red",
  92: "ansi-bright-green",
  93: "ansi-bright-yellow",
  94: "ansi-bright-blue",
  95: "ansi-bright-magenta",
  96: "ansi-bright-cyan",
  97: "ansi-bright-white",
};

const ANSI_BACKGROUND: Record<number, string> = {
  40: "ansi-bg-black",
  41: "ansi-bg-red",
  42: "ansi-bg-green",
  43: "ansi-bg-yellow",
  44: "ansi-bg-blue",
  45: "ansi-bg-magenta",
  46: "ansi-bg-cyan",
  47: "ansi-bg-white",
  100: "ansi-bg-bright-black",
  101: "ansi-bg-bright-red",
  102: "ansi-bg-bright-green",
  103: "ansi-bg-bright-yellow",
  104: "ansi-bg-bright-blue",
  105: "ansi-bg-bright-magenta",
  106: "ansi-bg-bright-cyan",
  107: "ansi-bg-bright-white",
};

const ANSI_STYLES: Record<number, string> = {
  1: "ansi-bold",
  2: "ansi-dim",
  3: "ansi-italic",
  4: "ansi-underline",
};

const ANSI_DETECT_REGEX =
  /\x1b\[[?0-9;:]*[@-~]|\+\[[0-9;:]*m|\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[@-_]/;
const CSI_PREFIX_REGEX = /^\x1b\[([?0-9;:]*)([@-~])/;
const PLUS_SGR_PREFIX_REGEX = /^\+\[([0-9;:]*)m/;
const OSC_PREFIX_REGEX = /^\x1b\][\s\S]*?(?:\x07|\x1b\\)/;

interface TerminalCell {
  char: string;
  classes: string[];
}

function isForegroundClass(cls: string): boolean {
  return (
    cls.startsWith("ansi-") &&
    !cls.startsWith("ansi-bg-") &&
    !cls.startsWith("ansi-bold") &&
    !cls.startsWith("ansi-dim") &&
    !cls.startsWith("ansi-italic") &&
    !cls.startsWith("ansi-underline")
  );
}

function isBackgroundClass(cls: string): boolean {
  return cls.startsWith("ansi-bg-");
}

export function ansiToHtml(text: string): string {
  let currentClasses: string[] = [];
  let row = 0;
  let col = 0;
  let lines: TerminalCell[][] = [[]];

  const ensureLine = (lineIndex: number): TerminalCell[] => {
    while (lines.length <= lineIndex) {
      lines.push([]);
    }
    return lines[lineIndex];
  };

  const blankCell = (): TerminalCell => ({ char: " ", classes: [] });

  const writeChar = (char: string): void => {
    const line = ensureLine(row);
    while (line.length < col) {
      line.push(blankCell());
    }
    line[col] = { char, classes: [...currentClasses] };
    col++;
  };

  const eraseLine = (mode: number): void => {
    const line = ensureLine(row);
    if (mode === 2) {
      line.length = 0;
    } else if (mode === 1) {
      for (let i = 0; i < Math.min(col, line.length); i++) {
        line[i] = blankCell();
      }
    } else {
      line.length = Math.min(col, line.length);
    }
  };

  const eraseDisplay = (mode: number): void => {
    if (mode === 2 || mode === 3) {
      lines = [[]];
      row = 0;
      col = 0;
      return;
    }

    if (mode === 1) {
      for (let i = 0; i < row; i++) {
        lines[i] = [];
      }
      const line = ensureLine(row);
      for (let i = 0; i < Math.min(col, line.length); i++) {
        line[i] = blankCell();
      }
      return;
    }

    const line = ensureLine(row);
    line.length = Math.min(col, line.length);
    lines.length = row + 1;
  };

  const removeStyleClass = (classes: string[]): void => {
    currentClasses = currentClasses.filter((c) => !classes.includes(c));
  };

  const applySgr = (rawParams: string): void => {
    const codes =
      rawParams.length === 0
        ? [0]
        : rawParams.split(/[;:]/).map((c) => parseInt(c, 10) || 0);

    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0) {
        currentClasses = [];
      } else if (ANSI_STYLES[code]) {
        const styleClass = ANSI_STYLES[code];
        if (!currentClasses.includes(styleClass)) {
          currentClasses.push(styleClass);
        }
      } else if (code === 22) {
        removeStyleClass(["ansi-bold", "ansi-dim"]);
      } else if (code === 23) {
        removeStyleClass(["ansi-italic"]);
      } else if (code === 24) {
        removeStyleClass(["ansi-underline"]);
      } else if (ANSI_FOREGROUND[code]) {
        currentClasses = currentClasses.filter((c) => !isForegroundClass(c));
        currentClasses.push(ANSI_FOREGROUND[code]);
      } else if (code === 39) {
        currentClasses = currentClasses.filter((c) => !isForegroundClass(c));
      } else if (ANSI_BACKGROUND[code]) {
        currentClasses = currentClasses.filter((c) => !isBackgroundClass(c));
        currentClasses.push(ANSI_BACKGROUND[code]);
      } else if (code === 49) {
        currentClasses = currentClasses.filter((c) => !isBackgroundClass(c));
      } else if (code === 38 || code === 48) {
        const colorMode = codes[i + 1];
        if (colorMode === 2) {
          i += 4;
        } else if (colorMode === 5) {
          i += 2;
        }
      }
    }
  };

  const firstParam = (rawParams: string, fallback: number): number => {
    const cleaned = rawParams.replace(/^\?/, "");
    const first = cleaned.split(/[;:]/)[0];
    const parsed = parseInt(first, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };

  const cursorPositionParams = (
    rawParams: string
  ): { nextRow: number; nextCol: number } => {
    const parts = rawParams
      .replace(/^\?/, "")
      .split(/[;:]/)
      .map((part) => parseInt(part, 10));
    return {
      nextRow: Math.max(0, (parts[0] || 1) - 1),
      nextCol: Math.max(0, (parts[1] || 1) - 1),
    };
  };

  const applyCsi = (rawParams: string, command: string): void => {
    if (command === "m" && !rawParams.startsWith("?")) {
      applySgr(rawParams);
      return;
    }

    const amount = firstParam(rawParams, 1);
    switch (command) {
      case "A":
        row = Math.max(0, row - amount);
        ensureLine(row);
        break;
      case "B":
        row += amount;
        ensureLine(row);
        break;
      case "C":
        col += amount;
        break;
      case "D":
        col = Math.max(0, col - amount);
        break;
      case "G":
        col = amount - 1;
        break;
      case "H":
      case "f": {
        const position = cursorPositionParams(rawParams);
        row = position.nextRow;
        col = position.nextCol;
        ensureLine(row);
        break;
      }
      case "J":
        eraseDisplay(firstParam(rawParams, 0));
        break;
      case "K":
        eraseLine(firstParam(rawParams, 0));
        break;
    }
  };

  const renderLine = (line: TerminalCell[]): string => {
    let html = "";
    let openClass = "";

    const closeSpan = (): void => {
      if (openClass) {
        html += "</span>";
        openClass = "";
      }
    };

    for (const cell of line) {
      const className = cell.classes.join(" ");
      if (className !== openClass) {
        closeSpan();
        if (className) {
          html += `<span class="${className}">`;
          openClass = className;
        }
      }
      html += escapeHtml(cell.char);
    }

    closeSpan();
    return html;
  };

  for (let i = 0; i < text.length; ) {
    const remaining = text.slice(i);
    const oscMatch = remaining.match(OSC_PREFIX_REGEX);
    if (oscMatch) {
      i += oscMatch[0].length;
      continue;
    }

    const csiMatch = remaining.match(CSI_PREFIX_REGEX);
    if (csiMatch) {
      applyCsi(csiMatch[1], csiMatch[2]);
      i += csiMatch[0].length;
      continue;
    }

    const plusSgrMatch = remaining.match(PLUS_SGR_PREFIX_REGEX);
    if (plusSgrMatch) {
      applySgr(plusSgrMatch[1]);
      i += plusSgrMatch[0].length;
      continue;
    }

    const char = text[i];
    if (char === "\r") {
      col = 0;
      i++;
    } else if (char === "\n") {
      row++;
      col = 0;
      ensureLine(row);
      i++;
    } else if (char === "\b") {
      col = Math.max(0, col - 1);
      i++;
    } else if (char === "\t") {
      const spaces = 4 - (col % 4);
      for (let j = 0; j < spaces; j++) {
        writeChar(" ");
      }
      i++;
    } else {
      const codePoint = text.codePointAt(i);
      if (codePoint === undefined) {
        break;
      }
      const charText = String.fromCodePoint(codePoint);
      if (codePoint >= 0x20 || charText.length > 1) {
        writeChar(charText);
      }
      i += charText.length;
    }
  }

  return lines.map(renderLine).join("\n");
}

export function hasAnsiCodes(text: string): boolean {
  return ANSI_DETECT_REGEX.test(text);
}
