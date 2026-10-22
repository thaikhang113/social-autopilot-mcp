// Throwaway check: Vietnamese README survived as real UTF-8 and is structurally sane.
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
check('VI keeps tool names verbatim', ['list_pending_events', 'decide', 'verify_facts', 'schedule_post', 'recent_activity'].every((n) => vi.includes(n)));
check('VI keeps env names verbatim', ['SAM_TOKEN', 'SAM_PORT', 'SAM_PUBLIC_HOST'].every((n) => vi.includes(n)));

process.exit(fail ? 1 : 0);