/**
 * المدقق D2 · الجولة الخامسة عشرة · على f5036b1 · شاشة «كشف الحساب والمطابقة» لا تعرض السطر المطابَق ولا تتيح إلغاء مطابقته، وحذف الكشف
 * الذي فيه سطرٌ مطابَق يُرفض «ألغِ مطابقتها أولاً» · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditD2.unmatchUi.test.ts
 *
 * D2-3 · متوسط · app/bankStatement.tsx:84-86 (قائمة السطور «status != 'matched'») وapp/bankStatement.tsx:307-310 (الاستدعاء الوحيد لـunmatchLine
 * زرّ «إعادة فتح» للمستبعَد وحده) مع src/domain/bankStatement/store.ts:303-306 (deleteStatement يرفض كشفاً فيه مطابَق): المالك يعتمد
 * «اعتماد الجاهزة» فيُطابَق إيداعٌ بحركةٍ خاطئة (المبلغ واحد والإيجار واحد)، أو يريد حذف كشفٍ قرأه خطأً وفيه سطرٌ مطابَق · لا يرى في الشاشة
 * السطر المطابَق (التقرير يعدّه رقماً «مطابَق n» فقط)، ولا زرّ «إلغاء المطابقة» في أي موضع، والحذف يُرفض برسالة تطلب ما لا تتيحه الشاشة ·
 * والطريق الوحيد حذف حركة البنك نفسها من الدفاتر (U١٩) أو إلغاء الدفعة.
 * لماذا يهم: جدول الصلاحيات في DESIGN §١٣.٢٢ «يعتمد مطابقةً أو يلغيها» لـ«البنوك ٣»، والاعتماد الجماعي بلا رجعةٍ من الشاشة · والكشف الذي
 * فيه مطابَقٌ واحد لا يُحذف أبداً من التطبيق.
 * السلوك الصحيح: للسطر المطابَق في الشاشة «إلغاء المطابقة» لمن له «البنوك ٣» (unmatchLine)، فيُحذف الكشف بعدها.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { depositCashToBank, ownerCashIn } from '@/domain/cashOps';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement, matchSuggestions, approveMatch, deleteStatement } from '@/domain/bankStatement/store';

const screen = fs.readFileSync(path.join(__dirname, '..', 'app', 'bankStatement.tsx'), 'utf8');

describe('D2-3 · [متوسط] لا «إلغاء مطابقة» في الشاشة، والكشف الذي فيه مطابَقٌ لا يُحذف منها (app/bankStatement.tsx:86 و307-310 · store.ts:304)', () => {
  test('الحذف يطلب إلغاء المطابقة أولاً (السياق في المنطق)', () => {
    const db = memDb();
    const bank = addBank(db, 'بنك مصطنع D2-3', 0);
    ownerCashIn(db, { amountHalalas: 100000, date: '2026-09-30' });
    depositCashToBank(db, { bankId: bank, amountHalalas: 100000, date: '2026-10-02', notes: 'إيداع نقدي مصطنع' });
    const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
      ['2026/10/02', 'إيداع نقدي مصطنع', '', '1,000.00', '1,000.00']]);
    if (!r.ok) throw new Error('لم يُقرأ'); // i18n-exempt: رسالة اختبار
    const { statementId } = saveStatement(db, bank, r, { name: 'oct-d2-3.csv', hash: 'd2-3' });
    for (const s of matchSuggestions(db, bank)) approveMatch(db, s.line.id, s.tx.id);
    expect(() => deleteStatement(db, statementId)).toThrow('ألغِ مطابقتها أولاً');
    db.close();
  });

  test('الشاشة تتيح unmatchLine للسطر المطابَق (لا للمستبعَد وحده)', () => {
    // كل استدعاءٍ لـunmatchLine في الشاشة (غير سطر الاستيراد) وشرطه قبله
    const calls = [...screen.matchAll(/unmatchLine\(db,/g)].map((m) => screen.slice(Math.max(0, m.index! - 260), m.index!));
    const forMatched = calls.filter((before) => before.includes("'matched'") || !before.includes("'excluded'"));
    // (الواقع: استدعاءٌ واحد تحت «l.status === 'excluded'»، والقائمة نفسها تستثني المطابَق «status != 'matched'»)
    expect(calls.length).toBeGreaterThan(0);
    expect(forMatched.length).toBeGreaterThan(0);
  });
});
