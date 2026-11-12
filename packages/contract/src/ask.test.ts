import { describe, expect, it } from "vitest";
import { splitAnswerCitations } from "./ask.js";

describe("splitAnswerCitations", () => {
  it("turns [N] markers into citation parts", () => {
    expect(splitAnswerCitations("We ship weekly [1]. Billing is monthly [2].", 2)).toEqual([
      { type: "text", text: "We ship weekly " },
      { type: "cite", n: 1 },
      { type: "text", text: ". Billing is monthly " },
      { type: "cite", n: 2 },
      { type: "text", text: "." },
    ]);
  });

  it("expands grouped markers into one part per source", () => {
    expect(splitAnswerCitations("Both agree [1, 3][2]", 3)).toEqual([
      { type: "text", text: "Both agree " },
      { type: "cite", n: 1 },
      { type: "cite", n: 3 },
      { type: "cite", n: 2 },
    ]);
  });

  it("leaves a marker with no matching source as text", () => {
    expect(splitAnswerCitations("Nothing here [7] or [0].", 2)).toEqual([
      { type: "text", text: "Nothing here [7] or [0]." },
    ]);
  });

  it("keeps an answer with no markers whole", () => {
    expect(splitAnswerCitations("The context does not say.", 0)).toEqual([
      { type: "text", text: "The context does not say." },
    ]);
  });
});
