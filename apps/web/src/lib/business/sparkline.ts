/**
 * The path of a sparkline: values scaled into a `width × height` box, one
 * `M`/`L` segment per run of known values. Pure so it is tested without a
 * DOM (`format.test.ts`); drawn by `components/business/sparkline.tsx`, the
 * one sparkline of every KPI card (overview and metrics views).
 *
 * Must not break: a null is a gap, not a zero, and a flat series draws a
 * flat line in the middle instead of dividing by zero.
 */
export function sparklinePath(values: readonly (number | null)[], width: number, height: number): string | null {
  const known = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (known.length < 2) return null;
  const min = Math.min(...known);
  const max = Math.max(...known);
  const pad = 2;
  const span = max - min;
  const x = (i: number) => (values.length === 1 ? width / 2 : (i / (values.length - 1)) * width);
  const y = (v: number) => (span === 0 ? height / 2 : pad + (1 - (v - min) / span) * (height - pad * 2));
  let d = "";
  let drawing = false;
  values.forEach((value, i) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      drawing = false;
      return;
    }
    d += `${drawing ? "L" : "M"}${x(i).toFixed(1)},${y(value).toFixed(1)}`;
    drawing = true;
  });
  return d || null;
}
