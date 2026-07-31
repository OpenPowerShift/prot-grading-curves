import { parseAndRender } from '../src/index.js';
const base = `
system { voltages { "HV" { kV = 33; } } }
faults { "F" { I_A = 9 kA; voltage = "HV"; } }
relay R_FDR { voltage = "HV"; ct_ratio = 250/1; element 51 { curve = iec.si; I_pu = 400 A; tms = 0.15; } }
relay R_INC { voltage = "HV"; ct_ratio = 250/1; element 51 { curve = iec.si; I_pu = 700 A; tms = 0.30; } }
view { voltage = "HV"; current_min = 100 A; current_max = 40 kA; }
`;
const arrowX = (annotate: string) => {
  const { svg } = parseAndRender(base + annotate, { theme: 'light' });
  const m = svg.match(/<line x1="([\d.]+)" y1="([\d.]+)" x2="\1" y2="([\d.]+)" stroke="[^"]*" stroke-width="1\.4"\/>/);
  const label = svg.match(/>CTI ([^<]+)</);
  return m ? `x=${m[1]}  span ${m[2]}->${m[3]}  label="${label?.[1]}"` : `NOT DRAWN (label=${label?.[1]})`;
};
console.log('fault  = "F"      :', arrowX('annotate { primary = R_FDR:51; backup = R_INC:51; fault = "F"; label = "CTI"; }'));
console.log('at_I_A = 9 kA     :', arrowX('annotate { primary = R_FDR:51; backup = R_INC:51; at_I_A = 9 kA; label = "CTI"; }'));
console.log('at_I_A = 2 kA     :', arrowX('annotate { primary = R_FDR:51; backup = R_INC:51; at_I_A = 2 kA; label = "CTI"; }'));
console.log('at_I_A = 20 kA    :', arrowX('annotate { primary = R_FDR:51; backup = R_INC:51; at_I_A = 20 kA; label = "CTI"; }'));

const hArrowY = (annotate: string) => {
  const { svg } = parseAndRender(base + annotate, { theme: 'light' });
  const m = svg.match(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="\2" stroke="[^"]*" stroke-width="1\.4"\/>/);
  const label = svg.match(/>IM ([^<]+)</);
  return m ? `y=${m[2]}  span ${m[1]}->${m[3]}  label="${label?.[1]}"` : 'NOT DRAWN';
};
console.log();
console.log('at_t_s = 100 ms   :', hArrowY('annotate { primary = R_FDR:51; backup = R_INC:51; at_t_s = 100 ms; label = "IM"; }'));
console.log('at_t_s = 1 s      :', hArrowY('annotate { primary = R_FDR:51; backup = R_INC:51; at_t_s = 1 s; label = "IM"; }'));
console.log('at_t_s = 5 s      :', hArrowY('annotate { primary = R_FDR:51; backup = R_INC:51; at_t_s = 5 s; label = "IM"; }'));
console.log();
console.log('--- both a condition and at_I_A on one annotate ---');
console.log('fault + at_I_A=2kA:', arrowX('annotate { primary = R_FDR:51; backup = R_INC:51; fault = "F"; at_I_A = 2 kA; label = "CTI"; }'));
