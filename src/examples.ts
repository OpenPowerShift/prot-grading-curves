/**
 * Built-in examples for the playground.
 *
 * The five prefixed `Gallery N` are the ones pictured in the README, in
 * the same order, so a reader who has just seen a sheet can find the
 * source behind it without matching filenames by eye. `?example=<id>`
 * on the URL opens one directly, which is what those README links use.
 *
 * The sources are imported *from the `.ptc` files themselves* with
 * Vite's `?raw` suffix, rather than being pasted in as template
 * literals. Those files are the ones the CLI renders and the test
 * suite validates, so importing them means the playground cannot drift
 * from them -- which it previously had, carrying a stale curve id and
 * missing a `view` block that the file version had gained.
 */

import minimal from '../examples/00-minimal.ptc?raw';
import riverside from '../examples/01-riverside.ptc?raw';
import singleRelay from '../examples/02-single-relay.ptc?raw';
import mixed from '../examples/03-mixed-ansi-iec.ptc?raw';
import multistage from '../examples/04-multistage.ptc?raw';
import transformer from '../examples/05-transformer-inrush.ptc?raw';
import secondary from '../examples/06-secondary-amps.ptc?raw';
import miscoordination from '../examples/07-upstream-miscoordination.ptc?raw';
import fuseRelay from '../examples/08-fuse-relay.ptc?raw';
import capabilityTour from '../examples/09-capability-tour.ptc?raw';
import cascade from '../examples/10-substation-cascade.ptc?raw';
import portraitDirect from '../examples/11-portrait-direct-labels.ptc?raw';
import sequenceScenario from '../examples/12-sequence-scenario.ptc?raw';
import clearanceTimes from '../examples/13-clearance-times.ptc?raw';
import devices from '../examples/14-devices-and-combine.ptc?raw';
import parallelFeeders from '../examples/15-parallel-feeders.ptc?raw';
import drawingStyle from '../examples/16-drawing-style.ptc?raw';
import sequenceSheets from '../examples/17-sequence-sheets.ptc?raw';

export interface Example {
  /** Stable key, also the value in the picker. */
  id: string;
  /** Label shown in the dropdown. */
  name: string;
  source: string;
}

const ALL: ReadonlyArray<Example> = [
  { id: 'riverside', name: 'Riverside 33/11 kV', source: riverside },
  { id: 'minimal', name: 'Gallery 1 — Minimal (two relays, one fault)', source: minimal },
  { id: 'single', name: 'Plant 480 V (single relay)', source: singleRelay },
  { id: 'mixed', name: 'Cross-vendor (ANSI MI + IEC VI)', source: mixed },
  { id: 'multistage', name: 'Multi-stage (composite)', source: multistage },
  { id: 'transformer', name: 'Transformer inrush + damage', source: transformer },
  { id: 'secondary', name: 'Settings in secondary amps', source: secondary },
  { id: 'miscoordination', name: 'Fails upstream (SI vs EI)', source: miscoordination },
  { id: 'fuse', name: 'Fuse / relay coordination', source: fuseRelay },
  { id: 'cascade', name: 'Gallery 2 — Four-level cascade (6 curves)', source: cascade },
  { id: 'portrait', name: 'Portrait sheet, direct labels', source: portraitDirect },
  { id: 'sequence', name: 'Sequence currents (scenario)', source: sequenceScenario },
  { id: 'clearance', name: 'Gallery 3 — Clearance times (arc flash, grid code)', source: clearanceTimes },
  { id: 'devices', name: 'Gallery 4 — Devices, fuses and combined curves', source: devices },
  { id: 'parallel', name: 'Parallel feeders (share, directional)', source: parallelFeeders },
  { id: 'style', name: 'House drawing style (every page option)', source: drawingStyle },
  { id: 'sheets', name: 'Gallery 5 — Sequence sheets (phase, I2, 3I2, 3I0)', source: sequenceSheets },
  { id: 'tour', name: 'Capability tour (every block)', source: capabilityTour },
];

/**
 * The picker's order: alphabetical by name.
 *
 * The list grew by accretion and its order recorded nothing but the
 * sequence they were written in, which is no use to someone looking for
 * one. Sorted, the five `Gallery N` entries also land together, which
 * is where a reader arriving from the README expects them.
 *
 * `localeCompare` with `numeric` so `Gallery 2` precedes `Gallery 10`
 * if the gallery ever grows.
 */
export const EXAMPLES: ReadonlyArray<Example> = [...ALL]
  .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));

/**
 * The study the playground opens on.
 *
 * Named rather than taken from the head of the list: sorting the picker
 * would otherwise have silently changed which study a first-time
 * visitor sees, which is not a decision alphabetical order should make.
 */
export const DEFAULT_EXAMPLE =
  EXAMPLES.find((e) => e.id === 'riverside') ?? EXAMPLES[0];
