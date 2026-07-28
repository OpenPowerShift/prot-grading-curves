/**
 * Categorical palettes for curve identity.
 *
 * A TCC colours by *which device* a curve belongs to -- identity, not
 * magnitude -- so these are categorical palettes and the rules that
 * follow are the categorical ones: fixed slot order, never a generated
 * hue, and separation that survives colour-vision deficiency.
 *
 * The `default` palette is validated against the six categorical
 * checks in both modes (lightness band, chroma floor, CVD separation,
 * normal-vision floor, contrast). Its dark column is the same eight
 * hues *re-stepped for the dark surface*, not an automatic flip --
 * flipping produces hues that are too light and too low-contrast on
 * dark ground.
 *
 * Worst adjacent CVD separation is dE 9.1 (light) / 8.4 (dark) against
 * a target of 8; worst normal-vision adjacent separation is 19.6 /
 * 19.3 against a floor of 15.
 *
 * The previous default (the matplotlib "tab10" opening) failed: its
 * green and orange sat dE 0.7 apart under protanopia -- indis-
 * tinguishable to a red-green colourblind reader, which on a grading
 * chart means being unable to tell which relay trips first.
 *
 * Three light-mode slots fall below 3:1 contrast on white. That is
 * permitted here under the relief rule because every curve is named in
 * the legend and the plot is never colour-alone.
 */

export type PaletteName =
  | 'default' | 'pasteur' | 'okabe_ito' | 'monochrome'
  | 'grayscale' | 'ieee' | 'high_contrast';

export type Palette = readonly string[];

/** Palettes whose steps differ between light and dark surfaces. */
const MODAL: Partial<Record<PaletteName, { light: Palette; dark: Palette }>> = {
  default: {
    light: [
      '#2a78d6', // blue
      '#eb6834', // orange
      '#1baf7a', // aqua
      '#eda100', // yellow
      '#e87ba4', // magenta
      '#008300', // green
      '#4a3aa7', // violet
      '#e34948', // red
    ],
    dark: [
      '#3987e5', '#d95926', '#199e70', '#c98500',
      '#d55181', '#008300', '#9085e9', '#e66767',
    ],
  },
};

const PALETTES: Record<PaletteName, Palette> = {
  default: MODAL.default!.light,
  pasteur: [
    '#cc3a05', '#cf78ad', '#0aaeb8', '#f1c40f', '#5cb85c',
    '#8a2727', '#a96cb9', '#7f7f7f',
  ],
  /* Okabe & Ito (2008) -- the reference colour-blind-safe set. */
  okabe_ito: [
    '#E69F00', '#56B4E9', '#009E73', '#F0E442',
    '#0072B2', '#D55E00', '#CC79A7', '#000000',
  ],
  monochrome: [
    '#1a1a1a', '#404040', '#666666', '#808080', '#a0a0a0',
  ],
  grayscale: ['#000000', '#3a3a3a', '#666666', '#888888', '#aaaaaa'],
  ieee: [
    '#cc0000', '#005f87', '#005900', '#a37f00', '#5d0096',
    '#9e9e00',
  ],
  high_contrast: [
    '#000000', '#E69F00', '#0072B2', '#D55E00',
  ],
};

export function palette(name: PaletteName = 'default'): Palette {
  return PALETTES[name] ?? PALETTES.default;
}

/**
 * Palette for a name *and a surface*.
 *
 * Dark mode is selected, not derived: a palette with a dark column
 * returns it here. Palettes without one (the archival and vendor sets)
 * are used as published in both modes.
 */
export function paletteFor(name: PaletteName = 'default', dark = false): Palette {
  const modal = MODAL[name];
  if (modal) return dark ? modal.dark : modal.light;

  /* Pure-black entries disappear on a dark surface; lift them. */
  const base = palette(name);
  if (!dark) return base;
  return base.map((c) => (c.toLowerCase() === '#000000' ? '#e6e6e6' : c));
}

export function paletteFromList(list: string[] | string): Palette {
  if (Array.isArray(list)) return list.length ? list : PALETTES.default;
  return PALETTES[(list as PaletteName)] ?? PALETTES.default;
}

export function isPaletteName(s: string): s is PaletteName {
  return Object.prototype.hasOwnProperty.call(PALETTES, s);
}

export const NAMED_PALETTES = Object.keys(PALETTES) as PaletteName[];

/**
 * Stroke dash for the n-th curve.
 *
 * Hues are assigned in fixed order and never re-generated. A study
 * with more curves than the palette has slots therefore reuses a hue,
 * and identity is preserved by *composite* encoding: the second time
 * round a hue appears it is dashed, the third dotted. Colour alone
 * never has to carry the distinction.
 */
export function strokeDashFor(index: number, paletteSize: number): string | undefined {
  const lap = Math.floor(index / Math.max(1, paletteSize));
  if (lap === 0) return undefined;
  if (lap === 1) return '7 4';
  if (lap === 2) return '2 3';
  return '10 3 2 3';
}
