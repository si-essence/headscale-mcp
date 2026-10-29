import { describe, expect, it } from "vitest";
import { diffPolicy } from "../src/policy-diff.js";

describe("diffPolicy", () => {
  it("counts added and removed lines and omits unchanged lines", () => {
    const diff = diffPolicy("a\nb\nc\n", "a\nc\nd");
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.diff).toContain("-b");
    expect(diff.diff).toContain("+d");
    expect(diff.diff).not.toContain("+a");
    expect(diff.truncated).toBe(false);
  });

  it("reports an empty diff when the policies match", () => {
    const diff = diffPolicy('{"acls":[]}', '{"acls":[]}');
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
    expect(diff.diff).toBe("");
  });
});
