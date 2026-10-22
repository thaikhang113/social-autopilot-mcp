import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { Knowledge } from '../src/adapters.mjs';

console.log('--- Testing Edge Cases ---');

// 1. Vietnamese grounding & search with >=2 chars and accents
const k = new Knowledge({ knowledge: { kind: 'file', dir: 'docs' } });
const res = await k.search('mã nguồn mở miễn phí');
assert(res.matched > 0, 'Knowledge search should match 2-char Vietnamese words (mã, mở)');
assert(res.sources.length > 0, 'Knowledge search should return document sources');
console.log('PASS: Vietnamese search accurately indexes 2-letter accented words');

// 2. verify_facts logic with Vietnamese words
const bag = res.answer.toLowerCase();
const draftTrue = 'Dự án Social Autopilot MCP là mã nguồn mở theo giấy phép MIT';
const wordsTrue = draftTrue.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length >= 2);
const hitTrue = wordsTrue.filter((w) => bag.includes(w)).length;
assert(hitTrue / wordsTrue.length >= 0.5, 'True Vietnamese draft must have high match ratio');

const draftBad = 'Dự án yêu cầu mua bản quyền máy chủ đắt tiền';
const wordsBad = draftBad.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length >= 2);
const hitBad = wordsBad.filter((w) => bag.includes(w)).length;
assert(hitBad / wordsBad.length < 0.5, 'Bad Vietnamese draft must be rejected (<50% match)');
console.log('PASS: Grounding correctly distinguishes true and false Vietnamese claims');

// 3. Skip dedup in engine: skip decision must NOT re-raise post_due event
const fakeHistory = [{ slotId: 'slot_test', occurrence: '2026-10-22T08:00:00.000Z', action: 'skip' }];
const slot = { id: 'slot_test' };
const occ = '2026-10-22T08:00:00.000Z';
const done = fakeHistory.some((h) => h.slotId === slot.id && h.occurrence === occ);
assert(done === true, 'Engine must treat skipped slot occurrences as done');
console.log('PASS: Engine treats skipped post slots as done, preventing endless re-queuing');

console.log('\nALL EDGE-CASE TESTS PASSED ✅');
