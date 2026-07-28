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
  { id: 'tour', name: 'Capability tour (every block)', source: capabilityTour },
];

export const DEFAULT_EXAMPLE = EXAMPLES[0];

export function exampleById(id: string | null | undefined): Example | undefined {
  return EXAMPLES.find((e) => e.id === id);
}
