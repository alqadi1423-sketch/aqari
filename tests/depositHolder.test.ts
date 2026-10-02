/**
 * جهة قبض التأمين · القيود الثلاثة كما في جدول المالك:
 * المكتب: مدين النقدية · منصة إيجار: مدين محتجزات لدى الغير (النقدية لا تتغيّر) · طرف آخر: لا قيد.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { accountBalance } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';

const setup = () => {
  const db = memDb();
  const pid = addProperty(db);
  return { db, unit: () => addUnit(db, pid) };
};

describe('جهة قبض التأمين', () => {
  test('المكتب: مدين النقدية 1100 · دائن التأمينات 2400', () => {
    const { db, unit } = setup();
    confirmContract(db, { ...contractInput(unit(), { depositHalalas: 100000 }), depositHolder: 'المكتب' });
    expect(accountBalance(db, '1100')).toBe(100000);
    expect(accountBalance(db, '2400')).toBe(100000);
    expect(accountBalance(db, '1260')).toBe(0);
    db.close();
  });

  test('منصة إيجار: النقدية لا تتغيّر · مدين محتجزات لدى الغير 1260', () => {
    const { db, unit } = setup();
    confirmContract(db, { ...contractInput(unit(), { depositHalalas: 100000 }), depositHolder: 'منصة إيجار' });
    expect(accountBalance(db, '1100')).toBe(0);       // النقدية لم تتغيّر — المال ليس عندنا
    expect(accountBalance(db, '1260')).toBe(100000);  // أصل محتجز لدى الغير
    expect(accountBalance(db, '2400')).toBe(100000);  // الالتزام قائم
    db.close();
  });

  test('طرف آخر: لا قيد إطلاقاً — بيان فقط · وفحص المطابقة يبقى سليماً', () => {
    const { db, unit } = setup();
    confirmContract(db, {
      ...contractInput(unit(), { depositHalalas: 100000 }),
      depositHolder: 'طرف آخر', depositHolderName: 'مكتب الوساطة الفلاني',
    });
    expect(accountBalance(db, '1100')).toBe(0);
    expect(accountBalance(db, '1260')).toBe(0);
    expect(accountBalance(db, '2400')).toBe(0);
    // الفحص الثالث لا يسقط: العقد مستثنى من المطابقة لأن تأمينه ليس في دفاترنا
    const c3 = integrityChecks(db).find((x) => x.name.includes('تأمينات المستأجرين'))!;
    expect(c3.ok).toBe(true);
    db.close();
  });
});
