/**
 * قواعد المنشأة في firestore.rules مولَّدة من OP_WRITES (src/domain/access/rulesGen.ts) ·
 * الحزمة تسقط إن اختلف الملف عن المولَّد. لتحديثه: UPDATE_RULES=1 npx jest tests/rulesGen.test.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateOrgRules, spliceRules, BEGIN, END } from '@/domain/access/rulesGen';
import { OP_WRITES } from '@/domain/access/opWrites';

const FILE = path.join(__dirname, '..', 'firestore.rules');

test('كتلة المنشأة في firestore.rules مطابقة للمولَّد', () => {
  const current = fs.readFileSync(FILE, 'utf8');
  const next = spliceRules(current);
  if (process.env.UPDATE_RULES === '1' && next !== current) fs.writeFileSync(FILE, next);
  const saved = fs.readFileSync(FILE, 'utf8');
  expect(saved.includes(generateOrgRules())).toBe(true);
  expect(saved.indexOf(BEGIN)).toBeLessThan(saved.indexOf(END));
});

test('كل قسم في OP_WRITES تظهر جداوله في القواعد', () => {
  const gen = generateOrgRules();
  for (const [s, w] of Object.entries(OP_WRITES)) {
    for (const t of [...w!.create, ...w!.own]) expect([s, t, gen.includes(`'${t}'`)]).toEqual([s, t, true]);
  }
});
