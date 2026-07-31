/**
 * Theme presets -- coordinated bundles of colours for background,
 * axes, labels, legend, etc.
 *
 *   * light       -- default, white background, dark gray ink.
 *   * dark        -- #1e1e1e background, light gray ink.
 *   * monochrome  -- pure black on white, archival.
 *   * print       -- CMYK-friendly, ICC profile in PDF.
 */

export interface Theme {
  background: string;
  foreground: string;
  axis: string;
  grid: string;
  label: string;
  legend: string;
  curve: string;  // default curve stroke before palette
  point: string;
  fault: string;  // fault-current vertical marker
}

export type ThemeName = 'light' | 'dark' | 'monochrome' | 'print';

export const THEMES: Record<ThemeName, Theme> = {
  /*
   * Surfaces and ink match the validated palette's reference surfaces
   * (#fcfcfb light, #1a1a19 dark), so the categorical steps are used
   * against the ground they were checked on.
   *
   * Axis and grid are recessive, but only to a point. On a log-log
   * TCC the sub-decade gridlines are *functional*: they are how a
   * reader gets a value between decades off the chart. Fading them to
   * near-invisible makes the plot prettier and useless.
   */
  light: {
    background: '#fcfcfb',
    foreground: '#0b0b0b',
    axis:      '#8a8983',
    grid:      '#cfcec8',
    label:     '#52514e',
    legend:    '#0b0b0b',
    curve:     '#2a78d6',
    /*
     * Marked points get their own ink, distinct from both the curve
     * blue and the fault red. They used to default to the fault
     * colour, which said a marked point was a fault current -- and on
     * a sheet carrying both, an inrush cross and a fault rule read as
     * the same kind of thing. Checked against the other two with
     * `scripts/validate_palette.js`: worst adjacent dE 19.1 under
     * protanopia, 20.9 normal.
     */
    point:     '#7d3c98',
    fault:     '#c0392b',
  },
  dark: {
    background: '#1a1a19',
    foreground: '#ffffff',
    axis:      '#6f6e68',
    grid:      '#3d3c38',
    label:     '#c3c2b7',
    legend:    '#ffffff',
    curve:     '#3987e5',
    /* Its own step for dark, not a flip of the light one; dE 14.2
     * protan against the fault red on the dark surface. */
    point:     '#b07cc6',
    fault:     '#e66767',
  },
  monochrome: {
    background: '#ffffff',
    foreground: '#000000',
    axis:      '#000000',
    grid:      '#aaaaaa',
    label:     '#000000',
    legend:    '#000000',
    curve:     '#000000',
    point:     '#000000',
    fault:     '#000000',
  },
  print: {
    background: '#ffffff',
    foreground: '#000000',
    axis:      '#000000',
    grid:      '#888888',
    label:     '#000000',
    legend:    '#000000',
    curve:     '#003366',
    point:     '#5b2c6f',
    fault:     '#cc0033',
  },
};

export function theme(name: ThemeName = 'light'): Theme {
  return THEMES[name] ?? THEMES.light;
}
