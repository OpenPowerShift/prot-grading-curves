/**
 * Pulling coincident curves apart, so a sheet does not show one line
 * where there are two relays.
 *
 * Four pairs in the shipped examples draw at exactly the same pixels.
 * The worst is sample 15: `Feeder A` and `Feeder B` are the same plant
 * with the same setting, so the sheet has one line and the legend has
 * two entries, and a reader cannot tell whether the second curve is
 * hidden, missing, or was never drawn. Near-coincidence is the same
 * problem softer -- two definite-time shelves at 60 ms, two elements
 * sharing a pickup.
 *
 * A nudge is deliberate error, so the rules it obeys matter more than
 * the geometry:
 *
 * - *The report is never touched.* Only the drawn path moves. Every
 *   number the study states, and every number it computes, is exact.
 * - *The sheet says it happened*, naming the curves. Without that the
 *   drawing claims two distinct settings.
 * - *Anything anchored to a curve moves with it.* The offset is applied
 *   to `pathD` before the label placer and the direct-label anchors
 *   read it, so they follow; a drawing whose parts disagree is worse
 *   than one where two lines coincide.
 *
 * The displacement is *perpendicular to the local path direction*,
 * which is the minimum-magnitude move that achieves a given separation
 * -- and it degenerates to the right thing in the two cases that
 * matter without a special case: on a definite-time shelf the
 * perpendicular is vertical, on a pickup riser it is horizontal.
 *
 * It is measured in *pixels*, applied after the scales have run. A
 * fixed pixel offset is a bounded visual error, constant on the page
 * at any paper size, and it shrinks in data terms exactly where the
 * axis is dense. Nudging in amps or seconds would impose a fixed
 * *relative* error everywhere and would change what the curve claims.
 */

/** One drawn characteristic, as the renderer holds it. */
export interface NudgeCandidate {
  /** Legend label, for the note. */
  label: string;
  /** SVG path data, `M x y L x y ...`. */
  pathD: string;
}

export interface NudgeOutcome {
  /** Paths in the order given, displaced where they coincide. */
  paths: string[];
  /** One line per group that was moved, for the sheet's notes. */
  notes: string[];
}

interface Point { x: number; y: number }

/** `M`/`L` runs, as `polylineRuns` in the renderer reads them. */
function parsePath(pathD: string): Point[][] {
  const runs: Point[][] = [];
  let current: Point[] = [];
  for (const m of pathD.matchAll(/([ML])\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/g)) {
    const x = Number(m[2]);
    const y = Number(m[3]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (m[1] === 'M') {
      if (current.length > 0) runs.push(current);
      current = [{ x, y }];
    } else {
      current.push({ x, y });
    }
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

function serialise(runs: Point[][]): string {
  return runs
    .filter((run) => run.length > 0)
    .map((run) => run
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join(' '))
    .join(' ');
}

/** Squared distance from `p` to the segment `a`-`b`. */
function distanceSq(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = p.x - a.x;
    const ey = p.y - a.y;
    return ex * ex + ey * ey;
  }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return (p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy);
}

interface Bounds { x0: number; y0: number; x1: number; y1: number }

function boundsOf(runs: Point[][]): Bounds | null {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const run of runs) {
    for (const p of run) {
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

function boundsApart(a: Bounds, b: Bounds, margin: number): boolean {
  return a.x1 + margin < b.x0 || b.x1 + margin < a.x0
    || a.y1 + margin < b.y0 || b.y1 + margin < a.y0;
}

/** True where `p` lies within `tol` of any segment of `runs`. */
function near(p: Point, runs: Point[][], tolSq: number): boolean {
  for (const run of runs) {
    if (run.length === 1) {
      const ex = p.x - run[0]!.x;
      const ey = p.y - run[0]!.y;
      if (ex * ex + ey * ey <= tolSq) return true;
      continue;
    }
    for (let i = 1; i < run.length; i++) {
      if (distanceSq(p, run[i - 1]!, run[i]!) <= tolSq) return true;
    }
  }
  return false;
}

/**
 * Unit normal at index `i` of `run`, from the direction either side.
 *
 * The central difference rather than one segment, so a point at a
 * corner -- the top of a pickup riser, where a curve turns through a
 * right angle -- gets the bisector rather than whichever segment
 * happened to be looked at.
 */
function normalAt(run: Point[], i: number): Point {
  const a = run[Math.max(0, i - 1)]!;
  const b = run[Math.min(run.length - 1, i + 1)]!;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  /* A zero-length neighbourhood has no direction; offsetting straight
   * down is as good an answer as any and never produces NaN. */
  if (!(len > 0)) return { x: 0, y: 1 };
  return { x: -dy / len, y: dx / len };
}

/** Smooth a 0/1 mask into a ramp, so the offset eases in and out. */
function taper(mask: boolean[], span: number): number[] {
  const out = new Array<number>(mask.length);
  for (let i = 0; i < mask.length; i++) {
    let sum = 0;
    let n = 0;
    for (let k = i - span; k <= i + span; k++) {
      if (k < 0 || k >= mask.length) continue;
      sum += mask[k] ? 1 : 0;
      n++;
    }
    out[i] = n > 0 ? sum / n : 0;
  }
  return out;
}

/**
 * Displace curves that coincide, leaving the rest untouched.
 *
 * `nudgePx` is the separation between neighbours in a group; `0` or
 * less returns the paths exactly as given, which is what makes the
 * feature opt-out-able without a second code path.
 */
export function nudgeCoincident(
  candidates: NudgeCandidate[],
  nudgePx: number,
): NudgeOutcome {
  const paths = candidates.map((c) => c.pathD);
  if (!(nudgePx > 0) || candidates.length < 2) return { paths, notes: [] };

  const runs = candidates.map((c) => parsePath(c.pathD));
  const bounds = runs.map(boundsOf);

  /*
   * Coincidence is decided over the whole path, not point by point.
   *
   * A group whose membership changed along the curve would make the
   * offset direction flip mid-line, which draws worse than the overlap
   * it was fixing. Membership is settled once; *where* the offset
   * applies is the per-point weight below.
   */
  const tol = Math.max(1.5, nudgePx);
  const tolSq = tol * tol;
  const COINCIDENT_FRACTION = 0.5;

  const overlaps = (i: number, j: number): boolean => {
    const bi = bounds[i];
    const bj = bounds[j];
    if (!bi || !bj || boundsApart(bi, bj, tol)) return false;
    const count = (from: Point[][], to: Point[][]): { near: number; total: number } => {
      let n = 0;
      let total = 0;
      for (const run of from) {
        for (const p of run) {
          total++;
          if (near(p, to, tolSq)) n++;
        }
      }
      return { near: n, total };
    };
    const a = count(runs[i]!, runs[j]!);
    const b = count(runs[j]!, runs[i]!);
    return (a.total > 0 && a.near / a.total >= COINCIDENT_FRACTION)
      || (b.total > 0 && b.near / b.total >= COINCIDENT_FRACTION);
  };

  /* Connected components: A with B and B with C puts all three in one
   * group, which is what keeps three identical curves evenly spread. */
  const group = candidates.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (group[r] !== r) r = group[r]!;
    return r;
  };
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      if (overlaps(i, j)) group[find(j)] = find(i);
    }
  }

  const members = new Map<number, number[]>();
  for (let i = 0; i < candidates.length; i++) {
    const root = find(i);
    const list = members.get(root);
    if (list) list.push(i); else members.set(root, [i]);
  }

  const notes: string[] = [];
  for (const list of members.values()) {
    if (list.length < 2) continue;

    /*
     * Spread symmetrically about the true position, ordered by
     * declaration. No curve carries all the error, the group's centre
     * is where the characteristic actually is, and the arrangement is
     * the same on every render.
     */
    for (const [rank, index] of list.entries()) {
      const offset = (rank - (list.length - 1) / 2) * nudgePx;
      if (offset === 0) continue;
      runs[index] = runs[index]!.map((run) => {
        /* Only where this curve is actually close to another of its
         * group: a curve that merges and parts is displaced where it
         * is ambiguous and drawn true where it is not. */
        const others = list.filter((k) => k !== index).map((k) => runs[k]!);
        const mask = run.map((p) => others.some((o) => near(p, o, tolSq)));
        const weight = taper(mask, 3);
        return run.map((p, i) => {
          const w = weight[i]!;
          if (w <= 0) return p;
          const n = normalAt(run, i);
          return { x: p.x + n.x * offset * w, y: p.y + n.y * offset * w };
        });
      });
    }

    const names = list.map((i) => candidates[i]!.label);
    notes.push(
      `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} coincide; `
      + `drawn ${nudgePx} px apart`,
    );
  }

  return {
    paths: runs.map((r, i) => (members.get(find(i))?.length ?? 1) > 1
      ? serialise(r)
      : paths[i]!),
    notes,
  };
}
