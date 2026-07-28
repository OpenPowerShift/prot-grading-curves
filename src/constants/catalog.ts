/**
 * Device catalog -- ship-with TCC assets for common fuses, cables,
 * transformer damage curves, reclosers, motor starts. References by
 * shorthand (e.g. `ferraz_abc_100a`).
 */

import type { FlexPoint } from '../parser/ast.js';

export interface CatalogEntry {
  kind: 'fuse' | 'recloser' | 'cable' | 'transformer_damage' | 'motor_startup' | 'breaker';
  maker: string;
  model: string;
  rating_A?: number;
  rating_kV?: number;
  rating_MVA?: number;
  /** Single-curve (cable / single-shot fuse) data. */
  flex_points?: FlexPoint[];
  /** Fuse band min-melt boundary. */
  min_melt?: FlexPoint[];
  /** Fuse band total-clear boundary. */
  total_clear?: FlexPoint[];
  /** Breaker clearing time. */
  t_delay_s?: number;
  reference: string;
}

/** Helper: convert a list of `[I, t]` paired numbers into FlexPoint[]. */
function pts(rows: Array<[number, number]>): FlexPoint[] {
  return rows.map(([I, t]) => ({ I_A: I, t_s: t }));
}

export const CATALOG: Record<string, CatalogEntry> = {
  /* ---------- Fuses ---------- */
  'ferraz_abc_100a': {
    kind: 'fuse',
    maker: 'Ferraz Shawmut',
    model: 'ABC (100 A)',
    rating_A: 100,
    min_melt:    pts([[130, 1000], [200, 100], [500, 1.0], [1000, 0.05], [2000, 0.005]]),
    total_clear: pts([[130, 60],   [200, 0.6], [500, 0.02], [1000, 0.005], [2000, 0.0015]]),
    reference: 'Ferraz Shawmut ABC bulletin, 100 A rating.',
  },
  'bussmann_jjl_50a': {
    kind: 'fuse',
    maker: 'Bussmann',
    model: 'JJL (50 A)',
    rating_A: 50,
    min_melt:    pts([[70, 1000], [100, 100], [250, 0.9], [500, 0.06], [1000, 0.005]]),
    total_clear: pts([[70, 100],  [100, 0.5], [250, 0.025], [500, 0.008], [1000, 0.002]]),
    reference: 'Bussmann JJL bulletin, 50 A rating.',
  },
  'mersen_a4bt_63a': {
    kind: 'fuse',
    maker: 'Mersen',
    model: 'A4BT (63 A)',
    rating_A: 63,
    min_melt:    pts([[80, 1000], [130, 100], [300, 1.0], [600, 0.06], [1200, 0.005]]),
    total_clear: pts([[80, 100],  [130, 0.6], [300, 0.02], [600, 0.005], [1200, 0.0015]]),
    reference: 'Mersen A4BT bulletin, 63 A rating.',
  },

  /* ---------- Cables ---------- */
  'urd_4_0_aepr_no7': {
    kind: 'cable',
    maker: 'Okonite',
    model: 'AEPR No.7',
    rating_A: 350,
    flex_points: pts([
      [350, 1_000_000], [1_000, 36_000], [3_000, 4_500],
      [10_000, 380], [30_000, 40], [60_000, 9.6],
    ]),
    reference: 'Okonite AEPR bulletin; ICEA P-32-382.',
  },

  /* ---------- Transformer damage ---------- */
  'tx_25mva_33_11kv': {
    kind: 'transformer_damage',
    maker: 'IEEE reference',
    model: '25 MVA, 33/11 kV',
    rating_MVA: 25,
    rating_kV: 33,
    flex_points: pts([
      [350, 2_000_000], [1_400, 8_000], [4_200, 800],
      [8_400, 200], [16_800, 50], [33_600, 12],
    ]),
    reference: 'IEEE C57.91.6 reference, 25 MVA 33/11 kV transformer through-fault limit.',
  },

  /* ---------- Reclosers ---------- */
  'recloser_cooper_form6_fast': {
    kind: 'recloser',
    maker: 'Cooper',
    model: 'Form 6 (fast curve)',
    flex_points: pts([
      [100, 5], [300, 0.8], [1_000, 0.15], [3_000, 0.025], [10_000, 0.008],
    ]),
    reference: 'Cooper Form 6 fast TCC bulletin.',
  },
  'recloser_cooper_form6_slow': {
    kind: 'recloser',
    maker: 'Cooper',
    model: 'Form 6 (slow curve)',
    flex_points: pts([
      [100, 30], [300, 6], [1_000, 1.0], [3_000, 0.15], [10_000, 0.05],
    ]),
    reference: 'Cooper Form 6 slow TCC bulletin.',
  },

  /* ---------- Motor startup ---------- */
  'motor_startup_induction_500hp': {
    kind: 'motor_startup',
    maker: 'NEMA MG-1',
    model: 'Induction 500 hp startup envelope',
    rating_A: 600,
    flex_points: pts([
      [300, 30], [600, 12], [1_500, 8], [3_000, 5], [6_000, 4], [10_000, 3.5],
    ]),
    reference: 'NEMA MG-1 typical 500 hp induction motor starting curve.',
  },
};

export function isKnownShorthand(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(CATALOG, id);
}

export function lookupCatalog(id: string): CatalogEntry | undefined {
  return CATALOG[id];
}
