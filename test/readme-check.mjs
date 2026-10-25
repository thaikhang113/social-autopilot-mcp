// Docs parity: catch drift between README.md and README.vi.md.
import fs from 'node:fs';

const FENCE = '`'.repeat(3);
let fail = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

for (const f of ['README.md', 'README.vi.md']) {
  const t = fs.readFileSync(f, 'utf8');
  const mojibake = (t.match(/Ã|ï¿½|\uFFFD/g) || []).length;
  check(`${f} no mojibake`, mojibake === 0, `bytes=${fs.statSync(f).size}`);
  check(`${f} fences balanced`, (t.split(FENCE).length - 1) % 2 === 0);
}

const vi = fs.readFileSync('README.vi.md', 'utf8');
const en = fs.readFileSync('README.md', 'utf8');
check('VI has Vietnamese diacritics', /[àáảãạăâđêôơưý]/i.test(vi));
check('VI links to English', vi.includes('](README.md)'));
check('EN links to Vietnamese', en.includes('](README.vi.md)'));
check('same section count', (vi.match(/^## /gm) || []).length === (en.match(/^## /gm) || []).length,
  `vi=${(vi.match(/^## /gm) || []).length} en=${(en.match(/^## /gm) || []).length}`);

const tools = ['list_pending_events', 'decide', 'verify_facts', 'schedule_post', 'cancel_slot', 'recent_activity'];
const envs = [
  'SAM_TOKEN',
  'SAM_PORT',
  'SAM_PUBLIC_HOST',
  'SAM_CONFIG_FILE',
  'SAM_DATA_DIR',
  'SAM_MAX_BODY_BYTES',
  'SAM_RATE_LIMIT',
  'SAM_LOG_MAX_BYTES',
  'SAM_HTTP_TIMEOUT_MS',
];
for (const [name, text] of [['EN', en], ['VI', vi]]) {
  check(`${name} keeps tool names verbatim`, tools.every((n) => text.includes(n)));
  check(`${name} keeps env names verbatim`, envs.every((n) => text.includes(n)));
  check(`${name} documents health/CORS/retry`, text.includes('/health') && text.includes('CORS') && text.includes('retry=true'));
}

process.exit(fail ? 1 : 0);