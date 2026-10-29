const MAX_LINES = 800;
const MAX_DIFF_CHARS = 6_000;

export interface PolicyDiff {
  readonly added: number;
  readonly removed: number;
  readonly diff: string;
  readonly truncated: boolean;
}

interface LineOp {
  readonly kind: "eq" | "add" | "del";
  readonly line: string;
}

function normalize(text: string): string[] {
  if (text.length === 0) return [];
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function lcsDiff(current: readonly string[], proposed: readonly string[]): LineOp[] {
  const n = current.length;
  const m = proposed.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const row = dp[i];
      const next = dp[i + 1];
      if (row === undefined || next === undefined) continue;
      if (current[i] === proposed[j]) row[j] = (next[j + 1] ?? 0) + 1;
      else row[j] = Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const out: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (current[i] === proposed[j]) {
      const line = current[i] ?? "";
      out.push({ kind: "eq", line });
      i += 1;
      j += 1;
      continue;
    }
    const down = dp[i + 1]?.[j] ?? 0;
    const right = dp[i]?.[j + 1] ?? 0;
    if (down >= right) {
      out.push({ kind: "del", line: current[i] ?? "" });
      i += 1;
    } else {
      out.push({ kind: "add", line: proposed[j] ?? "" });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ kind: "del", line: current[i] ?? "" });
    i += 1;
  }
  while (j < m) {
    out.push({ kind: "add", line: proposed[j] ?? "" });
    j += 1;
  }
  return out;
}

function bagCounts(current: readonly string[], proposed: readonly string[]): {
  added: number;
  removed: number;
} {
  const counts = new Map<string, number>();
  for (const line of current) counts.set(line, (counts.get(line) ?? 0) + 1);
  for (const line of proposed) counts.set(line, (counts.get(line) ?? 0) - 1);
  let added = 0;
  let removed = 0;
  for (const count of counts.values()) {
    if (count > 0) removed += count;
    if (count < 0) added += -count;
  }
  return { added, removed };
}

export function diffPolicy(current: string, proposed: string): PolicyDiff {
  const currentLines = normalize(current);
  const proposedLines = normalize(proposed);
  if (currentLines.length > MAX_LINES || proposedLines.length > MAX_LINES) {
    const counts = bagCounts(currentLines, proposedLines);
    return {
      added: counts.added,
      removed: counts.removed,
      diff: "Line diff omitted because the policy is longer than 800 lines.",
      truncated: true,
    };
  }
  let added = 0;
  let removed = 0;
  const lines: string[] = [];
  for (const op of lcsDiff(currentLines, proposedLines)) {
    if (op.kind === "eq") continue;
    if (op.kind === "add") {
      added += 1;
      lines.push(`+${op.line}`);
    } else {
      removed += 1;
      lines.push(`-${op.line}`);
    }
  }
  let diff = lines.join("\n");
  let truncated = false;
  if (diff.length > MAX_DIFF_CHARS) {
    diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n…`;
    truncated = true;
  }
  return { added, removed, diff, truncated };
}
