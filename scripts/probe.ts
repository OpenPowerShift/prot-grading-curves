import { KEYWORD_HELP, BLOCK_FIELDS, FIELD_VALUES } from '../src/help/help-data.js';
const missing = new Set<string>();
for (const [block, fields] of Object.entries(BLOCK_FIELDS))
  for (const f of fields) if (!KEYWORD_HELP[f]) missing.add(`${block}.${f}`);
console.log('fields with no hover entry:', [...missing].join(', '));
