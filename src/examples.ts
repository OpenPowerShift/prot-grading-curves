/**
 * Built-in examples for the playground.
 *
 * The sources are imported *from the `.tc` files themselves* with
 * Vite's `?raw` suffix, rather than being pasted in as template
 * literals. Those files are the ones the CLI renders and the test
 * suite validates, so importing them means the playground cannot drift
 * from them -- which it previously had, carrying a stale curve id and
 * missing a `view` block that the file version had gained.
 */

import riverside from '../examples/01-riverside.tc?raw';
import singleRelay from '../examples/02-single-relay.tc?raw';
import mixed from '../examples/03-mixed-ansi-iec.tc?raw';
import multistage from '../examples/04-multistage.tc?raw';
import transformer from '../examples/05-transformer-inrush.tc?raw';
import secondary from '../examples/06-secondary-amps.tc?raw';
import miscoordination from '../examples/07-upstream-miscoordination.tc?raw';
import fuseRelay from '../examples/08-fuse-relay.tc?raw';
import capabilityTour from '../examples/09-capability-tour.tc?raw';
import cascade from '../examples/10-substation-cascade.tc?raw';
import portraitDirect from '../examples/11-portrait-direct-labels.tc?raw';
import sequenceScenario from '../examples/12-sequence-scenario.tc?raw';
import clearanceTimes from '../examples/13-clearance-times.tc?raw';
import devices from '../examples/14-devices-and-combine.tc?raw';
import parallelFeeders from '../examples/15-parallel-feeders.tc?raw';
import drawingStyle from '../examples/16-drawing-style.tc?raw';
import sequenceSheets from '../examples/17-sequence-sheets.tc?raw';

export interface Example {
  /** Stable key, also the value in the picker. */
  id: string;
  /** Label shown in the dropdown. */
  name: string;
  source: string;
}

export const EXAMPLES: ReadonlyArray<Example> = [
  { id: 'riverside', name: 'Riverside 33/11 kV', source: riverside },
  { id: 'single', name: 'Plant 480 V (single relay)', source: singleRelay },
  { id: 'mixed', name: 'Cross-vendor (ANSI MI + IEC VI)', source: mixed },
  { id: 'multistage', name: 'Multi-stage (composite)', source: multistage },
  { id: 'transformer', name: 'Transformer inrush + damage', source: transformer },
  { id: 'secondary', name: 'Settings in secondary amps', source: secondary },
  { id: 'miscoordination', name: 'Fails upstream (SI vs EI)', source: miscoordination },
  { id: 'fuse', name: 'Fuse / relay coordination', source: fuseRelay },
  { id: 'cascade', name: 'Four-level cascade (6 curves)', source: cascade },
  { id: 'portrait', name: 'Portrait sheet, direct labels', source: portraitDirect },
  { id: 'sequence', name: 'Sequence currents (scenario)', source: sequenceScenario },
  { id: 'clearance', name: 'Clearance times (arc flash, grid code)', source: clearanceTimes },
  { id: 'devices', name: 'Devices, fuses and combined curves', source: devices },
  { id: 'parallel', name: 'Parallel feeders (share, directional)', source: parallelFeeders },
  { id: 'style', name: 'House drawing style (every page option)', source: drawingStyle },
  { id: 'sheets', name: 'Sequence sheets (phase, I2, 3I2, 3I0)', source: sequenceSheets },
  { id: 'tour', name: 'Capability tour (every block)', source: capabilityTour },
];

export const DEFAULT_EXAMPLE = EXAMPLES[0];
