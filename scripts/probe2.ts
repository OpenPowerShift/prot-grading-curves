import { parseAndRender, process } from '../src/index.js';
/* A margin spanning a transformer, placed with a bare at_I_A. */
const src = `
system { voltages { "HV" { kV = 33; } "LV" { kV = 11; } } }
faults { "F" { I_A = 6.4 kA; voltage = "LV"; } }
relay R_FDR { voltage = "LV"; ct_ratio = 400/5; element 51 { curve = iec.vi; I_pu = 480 A; tms = 0.25; } }
relay R_INC { voltage = "HV"; ct_ratio = 600/5; element 51 { curve = iec.si; I_pu = 720 A; tms = 0.30; } }
grade { primary = R_FDR:51; backup = R_INC:51; fault = "F"; CTI_min_s = 0.3; }
annotate { primary = R_FDR:51; backup = R_INC:51; at_I_A = 6.4 kA; label = "CTI"; }
view { voltage = "HV"; }
`;
const r = process(src);
console.log('report margin at the same current:', r.reports[0].rows.find((x) => x.at === 'I')!.margin_s.toFixed(3), 's');
console.log('annotation says               :', parseAndRender(src, { theme: 'light' }).svg.match(/>CTI ([^<]+)</)?.[1]);

const withLevel = src.replace('at_I_A = 6.4 kA;', 'at_I_A = 6.4 kA; voltage = "LV";');
console.log('with voltage = "LV"           :',
  parseAndRender(withLevel, { theme: 'light' }).svg.match(/>CTI ([^<]+)</)?.[1]);
console.log();
console.log('The fault is 6.4 kA at LV. A bare at_I_A = 6.4 kA is read in');
console.log('EACH side\'s own frame, so the HV side is evaluated at 6.4 kA at 33 kV');
console.log('instead of 6.4 x 11/33 = 2.13 kA. Hence the two disagree.');
