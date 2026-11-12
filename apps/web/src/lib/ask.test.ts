import { describe, expect, it } from "vitest";
import { synthesisHint } from "./ask";

describe("ask box hints", () => {
  it("adds nothing above a written answer", () => {
    expect(synthesisHint({ synthesis: "answered" })).toBeNull();
  });

  it("explains a server without a model as a hint, not an error", () => {
    const hint = synthesisHint({ synthesis: "no_model" });
    expect(hint).toMatch(/No AI model is configured/);
    expect(hint).not.toMatch(/error/i);
  });

  it("points an empty result at the agent", () => {
    expect(synthesisHint({ synthesis: "no_hits" })).toMatch(/Ask your agent/);
    expect(synthesisHint({ synthesis: "failed" })).toMatch(/closest nodes/);
  });
});
