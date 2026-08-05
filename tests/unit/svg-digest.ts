/**
 * A readable, diffable record of what a sheet actually draws.
 *
 * Screenshots are the obvious way to catch a layout regression and the
 * wrong one here. A PNG baseline answers "did anything change?" with a
 * pixel count, needs a browser or a native rasteriser to produce, and
 * differs between machines because it differs between font stacks. None
 * of that describes the thing under test: this renderer computes every
 * coordinate itself, so the coordinates *are* the drawing, and they can
 * be recorded exactly.
 *
 * So the baseline is a text digest -- one line per drawn element, with
 * its position and its identifying attributes. It is deterministic, it
 * is byte-identical on every machine, and a diff of it names what moved
 * and by how much instead of colouring in a rectangle.
 *
 * Two deliberate omissions:
 *
 *   - Path geometry is summarised (point count and bounding box) rather
 *     than written out. A curve is several hundred coordinates and
 *     nobody reads that in a review; what a reviewer needs to know is
 *     whether it moved.
 *   - Grouping is ignored. Elements are listed in document order with
 *     their layer named, so wrapping a phase in a `<g>` shows up as a
 *     changed layer name and *not* as every element moving. That is
 *     what lets the semantic-layer work be proved to change nothing but
 *     the structure.
 */

/** One drawn thing, in document order. */
export interface DigestEntry {
  kind: 'text' | 'line' | 'path' | 'rect' | 'circle' | 'polygon';
  layer: string;
  line: string;
}

const NUM = /^-?\d*\.?\d+(e-?\d+)?$/i;

/** Trim a coordinate to the precision the renderer itself emits. */
const n = (v: string | undefined): string => {
  if (v === undefined) return '-';
  return NUM.test(v) ? Number(v).toFixed(1) : v;
};

const attr = (raw: string, name: string): string | undefined =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(raw)?.[1];

/** Attributes that identify an element, as opposed to styling it. */
const IDENTITY = [
  'class', 'data-curve', 'data-ref', 'data-voltage', 'data-time-name',
  'data-fault', 'data-point', 'data-annotation', 'text-anchor',
  'font-size', 'font-weight', 'font-style',
];

const identityOf = (raw: string): string =>
  IDENTITY.map((a) => [a, attr(raw, a)] as const)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([a, v]) => `${a}=${v}`)
    .join(' ');

/** Bounding box and point count of a path's `d`, to one decimal. */
export function pathSummary(d: string): string {
  const coords = [...d.matchAll(/(-?\d*\.?\d+(?:e-?\d+)?)[, ]+(-?\d*\.?\d+(?:e-?\d+)?)/gi)]
    .map((m) => [Number(m[1]), Number(m[2])] as const)
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (coords.length === 0) return 'empty';
  const xs = coords.map(([x]) => x);
  const ys = coords.map(([, y]) => y);
  return `n=${coords.length} `
    + `bbox=${Math.min(...xs).toFixed(1)},${Math.min(...ys).toFixed(1)}`
    + `..${Math.max(...xs).toFixed(1)},${Math.max(...ys).toFixed(1)}`;
}

/** Strip markup from a `<text>` body, keeping the words. */
export const textOf = (body: string): string =>
  body.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

/**
 * Walk the SVG, tracking which `<g data-layer>` is open.
 *
 * A hand-rolled scan rather than a DOM parse: the digest has to run in
 * the unit suite, jsdom's SVG support is partial, and the renderer's
 * output is machine-written markup with no surprises in it.
 */
export function digestEntries(svg: string): DigestEntry[] {
  const entries: DigestEntry[] = [];
  const stack: string[] = [];

  const token = /<(\/?)(g|text|line|path|rect|circle|polygon)\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = token.exec(svg)) !== null) {
    const [, closing, tag, raw, selfClose] = m;
    const layer = stack.length > 0 ? stack[stack.length - 1] : '-';

    if (tag === 'g') {
      if (closing) stack.pop();
      else if (!selfClose) stack.push(attr(raw, 'data-layer') ?? layer);
      continue;
    }
    if (closing) continue;

    if (tag === 'text') {
      /* `<text>` is the only tag here with a body worth recording. */
      const bodyEnd = svg.indexOf('</text>', token.lastIndex);
      const body = bodyEnd === -1 ? '' : svg.slice(token.lastIndex, bodyEnd);
      entries.push({
        kind: 'text',
        layer,
        line: `text ${n(attr(raw, 'x'))},${n(attr(raw, 'y'))} `
          + `${identityOf(raw)} "${textOf(body)}"`,
      });
      continue;
    }
    if (tag === 'line') {
      entries.push({
        kind: 'line',
        layer,
        line: `line ${n(attr(raw, 'x1'))},${n(attr(raw, 'y1'))}`
          + `..${n(attr(raw, 'x2'))},${n(attr(raw, 'y2'))} ${identityOf(raw)}`,
      });
      continue;
    }
    if (tag === 'path') {
      entries.push({
        kind: 'path',
        layer,
        line: `path ${pathSummary(attr(raw, 'd') ?? '')} ${identityOf(raw)}`,
      });
      continue;
    }
    if (tag === 'rect') {
      entries.push({
        kind: 'rect',
        layer,
        line: `rect ${n(attr(raw, 'x'))},${n(attr(raw, 'y'))} `
          + `${n(attr(raw, 'width'))}x${n(attr(raw, 'height'))} ${identityOf(raw)}`,
      });
      continue;
    }
    if (tag === 'circle') {
      entries.push({
        kind: 'circle',
        layer,
        line: `circle ${n(attr(raw, 'cx'))},${n(attr(raw, 'cy'))} `
          + `r=${n(attr(raw, 'r'))} ${identityOf(raw)}`,
      });
      continue;
    }
    entries.push({
      kind: 'polygon',
      layer,
      line: `polygon ${(attr(raw, 'points') ?? '').split(/\s+/).length} pts ${identityOf(raw)}`,
    });
  }
  return entries;
}

/** The digest for one sheet, as the text that gets committed. */
export function digest(svg: string): string {
  const head = [
    `viewBox ${/viewBox="([^"]*)"/.exec(svg)?.[1] ?? '?'}`,
    `plot ${/data-plot="([^"]*)"/.exec(svg)?.[1] ?? '?'}`,
    `domain-i ${/data-domain-i="([^"]*)"/.exec(svg)?.[1] ?? '?'}`,
    `domain-t ${/data-domain-t="([^"]*)"/.exec(svg)?.[1] ?? '?'}`,
  ];
  const body = digestEntries(svg).map((e) => `[${e.layer}] ${e.line}`.trimEnd());
  return [...head, '', ...body, ''].join('\n');
}

/**
 * A text label's box, for the collision checks.
 *
 * jsdom has no layout engine and neither the renderer nor the test can
 * ask a font for its metrics, so width comes from the same mean-advance
 * estimate the renderer uses to place things. That makes the two agree
 * with each other, which is the property a collision test needs -- an
 * independently "correct" width the placer never saw would report
 * overlaps the placer had no way to avoid.
 */
export const CHAR_ADVANCE = 0.6;

export interface LabelBox {
  x: number; y: number; w: number; h: number;
  text: string; layer: string; anchor: string; size: number;
}

export function labelBoxes(svg: string): LabelBox[] {
  const boxes: LabelBox[] = [];
  for (const e of digestEntries(svg)) {
    if (e.kind !== 'text') continue;
    const m = /^text ([-\d.]+),([-\d.]+) (.*?)"(.*)"$/.exec(e.line);
    if (!m) continue;
    const text = m[4];
    if (text === '') continue;
    const attrs = m[3];
    const size = Number(/font-size=([\d.]+)/.exec(attrs)?.[1] ?? 11);
    const anchor = /text-anchor=(\w+)/.exec(attrs)?.[1] ?? 'start';
    const w = text.length * size * CHAR_ADVANCE;
    const x = Number(m[1]);
    const y = Number(m[2]);
    boxes.push({
      x: anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x,
      /* `y` is the baseline; the box is the cap height above it. */
      y: y - size * 0.8,
      w,
      h: size,
      text, layer: e.layer, anchor, size,
    });
  }
  return boxes;
}

/** Do two boxes overlap, allowing a shared edge? */
export const boxesOverlap = (a: LabelBox, b: LabelBox): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
