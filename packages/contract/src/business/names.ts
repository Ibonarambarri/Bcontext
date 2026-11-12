/**
 * The words a workspace calls the sides of its market — "suppliers" may be
 * Instructors, "buyers" Clients — and the one function that swaps them into
 * fixed copy: KPI labels ("Active suppliers"), template view names
 * ("Suppliers"), heatmap legends ("bookings per supplier").
 *
 * Who uses it: the API's metrics summary (KPI labels and definitions, so MCP
 * and the web read the same words), the web's business overview, sidebar and
 * view header (template view names) and the heatmap renderer.
 *
 * The side is found by the record type's KEY (`supplier`, `buyer`,
 * `customer`), which a template fixes and a rename never touches; the words
 * come from its `label` / `label_plural`. A workspace that kept the template
 * labels gets no entry, so its copy is byte-for-byte what it was.
 *
 * Must not break: metric keys never change — only what a person reads — and
 * a view a person renamed keeps their name (`displayViewName`).
 */
import type { RecordTypeDefinition } from "./record-types.js";

/** The words fixed copy uses for each side, and the record type key that names it. */
export const SIDE_WORDS = ["supplier", "buyer", "customer"] as const;
export type SideWord = (typeof SIDE_WORDS)[number];

export interface SideName {
  one: string;
  many: string;
}

/** Only the sides a workspace renamed. */
export type SideNames = Partial<Record<SideWord, SideName>>;

/**
 * The renamed sides of a workspace, from its record types. A type whose
 * label is still the word itself ("Supplier"/"Suppliers") is not a rename.
 */
export function sideNames(types: ReadonlyArray<Pick<RecordTypeDefinition, "key" | "label" | "label_plural">>): SideNames {
  const out: SideNames = {};
  for (const word of SIDE_WORDS) {
    const type = types.find((candidate) => candidate.key === word);
    if (!type) continue;
    const one = type.label.trim();
    const many = (type.label_plural ?? "").trim() || `${one}s`;
    if (!one) continue;
    if (one.toLowerCase() === word && many.toLowerCase() === `${word}s`) continue;
    out[word] = { one, many };
  }
  return out;
}

/**
 * Lower-case a display name for use mid-sentence ("Instructors" →
 * "instructors"), but leave an acronym or a name with capitals inside it
 * ("VIP clients", "eBikers") alone.
 */
function midSentence(name: string): string {
  if (name.length > 1 && name[1] === name[1]!.toUpperCase() && name[1] !== name[1]!.toLowerCase()) return name;
  return name.charAt(0).toLowerCase() + name.slice(1);
}

function capitalised(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const SIDE_PATTERN = new RegExp(`\\b(${SIDE_WORDS.join("|")})(s?)\\b`, "gi");

/**
 * `text` with every side word replaced by the workspace's name for it,
 * keeping singular/plural and an initial capital. Words of sides the
 * workspace did not rename are left as they are.
 */
export function renameSides(text: string, names: SideNames): string {
  if (!text || Object.keys(names).length === 0) return text;
  return text.replace(SIDE_PATTERN, (match, word: string, plural: string) => {
    const name = names[word.toLowerCase() as SideWord];
    if (!name) return match;
    const chosen = plural ? name.many : name.one;
    return match.charAt(0) === match.charAt(0).toUpperCase() ? capitalised(chosen) : midSentence(chosen);
  });
}

/**
 * The template views whose names say a side, by marker → template name.
 * Spelled out rather than read from `templates.ts`: this module ships in the
 * web shell (the sidebar), and the templates would carry zod and every
 * definition into it. `names.test.ts` checks the two agree.
 */
export const TEMPLATE_SIDE_VIEW_NAMES: Readonly<Record<string, string>> = {
  "marketplace:suppliers": "Suppliers",
  "b2c:customers": "Customers",
};

/**
 * The name to show for a saved view: a template view still carrying its
 * template name follows the side's rename ("Suppliers" → "Instructors");
 * any view a person named themselves is shown as they named it.
 */
export function displayViewName(
  view: { name: string; presentation: { layout?: Record<string, unknown> } },
  names: SideNames,
): string {
  const marker = view.presentation.layout?.template;
  if (typeof marker !== "string" || TEMPLATE_SIDE_VIEW_NAMES[marker] !== view.name) return view.name;
  return renameSides(view.name, names);
}
