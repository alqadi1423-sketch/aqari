/**
 * قواعد المنشأة في firestore.rules مولَّدة من OP_WRITES (src/domain/access/rulesGen.ts) ·
 * الحزمة تسقط إن اختلف الملف عن المولَّد. لتحديثه: UPDATE_RULES=1 npx jest tests/rulesGen.test.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateOrgRules, spliceRules, BEGIN, END, LINK_COLS } from '@/domain/access/rulesGen';
import { OP_WRITES } from '@/domain/access/opWrites';
import { SYNC_TABLES } from '@/db/syncTables';
import { isMoneyColumn } from '@/domain/access/readSections';
import { memDb } from './helpers/testDb';

/** أعمدة المبالغ في كل جدول مُزامَن من المخطط نفسه (المراجعة #17) */
function rulesSchema() {
  const db = memDb();
  const money: Record<string, string[]> = {};
  const links: Record<string, string[]> = {};
  for (const { name } of SYNC_TABLES) {
    const all = db.all<{ name: string }>(`PRAGMA table_info("${name}")`).map((c) => c.name);
    const cols = all.filter(isMoneyColumn);
    if (cols.length) money[name] = cols;
    // أعمدة الربط الموجودة في الجدول بترتيب rowPids (حدّ الألف تعبير)
    links[name] = LINK_COLS.map(([c]) => c).filter((c) => all.includes(c));
  }
  db.close();
  return { money, links };
}

const FILE = path.join(__dirname, '..', 'firestore.rules');

test('كتلة المنشأة في firestore.rules مطابقة للمولَّد', () => {
  const current = fs.readFileSync(FILE, 'utf8');
  const next = spliceRules(current, rulesSchema());
  if (process.env.UPDATE_RULES === '1' && next !== current) fs.writeFileSync(FILE, next);
  const saved = fs.readFileSync(FILE, 'utf8');
  expect(saved.includes(generateOrgRules(rulesSchema()))).toBe(true);
  expect(saved.indexOf(BEGIN)).toBeLessThan(saved.indexOf(END));
});

test('كل قسم في OP_WRITES تظهر جداوله في القواعد', () => {
  const gen = generateOrgRules();
  // opCreates تعبيرٌ نمطي على «قسم:جدول» (حدّ الألف تعبير): كل جدولٍ في مجموعة قسمه
  const createRx = /function opCreates\(op, t\) \{\s*return op is string && \(op \+ ':' \+ t\)\.matches\('([^']*)'\);/.exec(gen)![1];
  for (const [s, w] of Object.entries(OP_WRITES)) {
    const group = new RegExp(`(?:^|\\|)${s}:\\(([^)]*)\\)`).exec(createRx)?.[1].split('|') ?? [];
    for (const t of [...w!.create, ...w!.own]) expect([s, t, group.includes(t)]).toEqual([s, t, true]);
  }
});
