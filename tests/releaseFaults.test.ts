/**
 * أعطال اختبار الإصدار (المالك ٢٠٢٦-١٠-٠٥) · كل اختبار يثبت ما ظهر على الهاتف ولا يعود. بيانات مصطنعة.
 */
import type { DB } from '@/db/adapter';
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { savePurchase } from '@/domain/purchases';
import { computeTopPerformers, propertyStats, portfolioStats } from '@/domain/stats';

describe('الإحصاءات لا تعرف المحذوف إلى السلة', () => {
  test('عقارٌ ووحداته في السلة وعقودها قائمة: لا «الأكثر صرفاً» ولا إشغال «٢٢ من ٠»', () => {
    const db = memDb();
    const T = '2026-06-15';
    const p = addProperty(db, { name: 'عقار في السلة' });
    for (let i = 0; i < 3; i++) confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'S-' + i }), { tenant: 'مستأجر ' + i, idNumber: '100000010' + i, phone: '050000010' + i, start: '2026-01-01', end: '2026-12-31' }));
    savePurchase(db, { supplier: 'مورد', date: '2026-03-01', due: '2026-03-31', category: 'صيانة', incorpItem: '', amortize: false, amortizeMonths: null, exempt: false, excludeFromVat: false, subtotalHalalas: 9000, taxHalalas: 0, totalHalalas: 9000, propertyId: p });
    expect(computeTopPerformers(db).topPropExpense?.id).toBe(p);
    db.run(`UPDATE units SET deleted_at = '2026-06-01T00:00:00Z'`);
    db.run(`UPDATE properties SET deleted_at = '2026-06-01T00:00:00Z'`);
    expect(computeTopPerformers(db).topPropExpense).toBeNull();
    const s = portfolioStats(db, T);
    expect([s.total, s.occupied]).toEqual([0, 0]);
    expect(propertyStats(db, p, T).occupied).toBe(0);
  });
});

describe('المزامنة لا تحجب الواجهة · وأول سحب يظهر تدريجياً', () => {
  test('جهاز جديد يسحب منشأة: التطبيق صفحات قصيرة يفسح بينها للواجهة، والتقدم ظاهر، والنتيجة كاملة', async () => {
    const { MemoryRemote } = await import('./helpers/memoryRemote');
    const { enableSync, syncOnce } = await import('@/sync/engine');
    const { recordRentPayment } = await import('@/domain/contracts/service');
    const { DISCOUNT_AFTER_DUE } = await import('@/domain/contracts/installments');
    const { getMeta } = await import('@/repos/settings');
    const { allInstallments } = await import('@/domain/stats');
    const T = '2026-06-15';
    const src = memDb();
    const p = addProperty(src, { name: 'عقار السحب' });
    for (let u = 0; u < 24; u++) {
      const c = confirmContract(src, contractInput(addUnit(src, p, { unit_no: 'P-' + u }), { tenant: 'مستأجر سحب ' + u, idNumber: '10000020' + String(u).padStart(2, '0'), phone: '05000020' + String(u).padStart(2, '0'), start: '2026-01-01', end: '2026-12-31', valueHalalas: 1200000, cycle: 'شهرية', depositHalalas: 0 }));
      const ins = src.all<{ id: string; due_date: string }>(`SELECT id, due_date FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 5`, [c]);
      for (const [k, it] of ins.entries()) recordRentPayment(src, c, { installmentId: it.id, period: it.due_date, date: it.due_date, lines: [{ method: 'cash', amountHalalas: k % 2 ? 100000 : 90000 }], discountHalalas: k % 2 ? 0 : 10000, discountKind: k % 2 ? undefined : DISCOUNT_AFTER_DUE, notes: '' });
    }
    const remote = new MemoryRemote();
    enableSync(src, 'u-pull');
    await syncOnce(src, remote, getMeta(src, 'device_id')!);

    const fresh = memDb();
    enableSync(fresh, 'u-pull');
    const progress: string[] = [];
    // قِصَر الخطوة يُقاس بما تطبّقه بين فسحتين (صفوفٌ لا زمن): الزمن في jest يطول بزحام العمّال فيفشل بلا خلل، والسرعة
    // تُقاس على الجوال وحده · ومعه سقفٌ واسع بالزمن الفعلي يمسك خطوةً تعلق (التحقق المستقل)
    let longestWall = 0, steps = 0, lastWall = Date.now();
    const rep = await syncOnce(fresh, remote, getMeta(fresh, 'device_id')!, (m) => progress.push(m), {
      pause: async () => { longestWall = Math.max(longestWall, Date.now() - lastWall); steps++; await new Promise((r) => setTimeout(r, 0)); lastWall = Date.now(); },
    });
    expect(rep.pending).toBe(0);
    // صفحات كثيرة لا خطوة واحدة، وكل خطوة لا تزيد على صفحة (٦٠ صفاً) · والتقدم يُعرض بعددٍ يكبر
    expect(steps).toBeGreaterThan(10);
    const done = progress.map((m) => /^جاري تطبيق الوارد · (\d+) من/.exec(m)).filter(Boolean).map((m) => Number(m![1]));
    const biggest = Math.max(...done.map((d, i) => d - (i ? done[i - 1] : 0)));
    expect(biggest).toBeLessThanOrEqual(60);
    // سقفٌ لخطوةٍ تعلق لا لزحام الجهاز: ثوانٍ عشر (تحت زحام العمّال بلغت الخطوة ثانيتين)
    expect(longestWall).toBeLessThan(10000);
    expect(progress.filter((m) => m.startsWith('جاري تطبيق الوارد · ')).length).toBeGreaterThan(10);
    // والنتيجة كما في المصدر: لا خصم يظهر متبقياً
    const view = (d: typeof src) => allInstallments(d, T).map((i) => i.installmentId + ':' + i.paid + ':' + i.discount + ':' + i.remaining).sort().join(',');
    expect(view(fresh)).toBe(view(src));
  });

  test('خصم القسط يبدأ من القيد لا من سطور حساب الخصم كلها · في الشاشات ومحفّزات السقف', async () => {
    const { INSTALLMENT_DISCOUNT_SQL } = await import('@/domain/contracts/installments');
    const db = memDb();
    const plan = db.all<{ detail: string }>(`EXPLAIN QUERY PLAN SELECT i.id, ${INSTALLMENT_DISCOUNT_SQL} AS d FROM contract_installments i WHERE i.id = ?`, ['x'])
      .map((r) => r.detail).join('\n');
    expect(plan).not.toMatch(/ix_jl_account\b/);
    expect(plan).toMatch(/ix_jl_entry_account/);
    // والإحصاءات تبقى بعد إعادة الفتح والهجرة
    expect(Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_stat1 WHERE idx = 'ix_jl_account'`)!.n)).toBe(1);
  });
});

describe('لا محتوى مزروعاً (قرار المالك ٢٠٢٦-١٠-٠٥)', () => {
  test('قاعدة جديدة بلا قوالب رسائل ولا قالب استلام · ودليل الحسابات والإعدادات والمنشأة باقية', () => {
    const db = memDb();
    const n = (t: string) => Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)!.n);
    expect([n('message_scripts'), n('form_templates')]).toEqual([0, 0]);
    expect(n('accounts')).toBeGreaterThan(10);
    expect(n('settings')).toBeGreaterThan(5);
    expect(n('company')).toBe(1);
  });

  test('الهجرة ٢٦: ما زُرع ولم يُعدَّل يُحذف ويُرفع حذفه · وما عُدّل يبقى · وجهاز العضو لا يحذف', async () => {
    const { openNodeDb } = await import('@/db/nodeAdapter');
    const { MIGRATIONS } = await import('@/db/schema');
    const { migrate } = await import('@/db/migrations');
    const { LEGACY_SEED_SCRIPTS, LEGACY_HANDOVER_TEMPLATE } = await import('@/db/seed');
    const at25 = (member: boolean, editHandover: boolean) => {
      const db = openNodeDb(':memory:');
      db.exec('PRAGMA foreign_keys = OFF');
      for (let v = 0; v < 25; v++) db.exec(MIGRATIONS[v]);
      db.exec('PRAGMA user_version = 25');
      db.exec('PRAGMA foreign_keys = ON');
      // ما كان يزرعه الإصدار السابق · بمعرّفاته الثابتة وبمعرّف عشوائي قديم
      LEGACY_SEED_SCRIPTS.forEach((s, i) => db.run(`INSERT INTO message_scripts (id, audience, category, title, body, created_at) VALUES (?,?,?,?,?,?)`,
        [i === 3 ? 'old-random-id' : 'MS-SEED-' + (i + 1), s.audience, 'عام', s.title, i === 1 ? s.body + ' (عدّلها المستخدم)' : s.body, 'x']));
      db.run(`INSERT INTO message_scripts (id, audience, category, title, body, created_at) VALUES ('mine','مستأجرون','عام','قالبي','نص كتبه المستخدم','x')`);
      const tpl = editHandover ? [...LEGACY_HANDOVER_TEMPLATE, { section: 'قسم أضافه المستخدم', items: ['بند'] }] : LEGACY_HANDOVER_TEMPLATE;
      db.run(`INSERT INTO form_templates (id, name, is_system, sections_json, created_at) VALUES ('FT-HANDOVER','نموذج استلام وتسليم',1,?,'x')`, [JSON.stringify(tpl)]);
      db.run(`INSERT INTO sync_state (k, v) VALUES ('uid', 'u1')`);
      if (member) db.run(`INSERT INTO sync_state (k, v) VALUES ('membership', '{}')`);
      db.run(`UPDATE sync_ctl SET v = 1 WHERE k = 'capture'`);
      return db;
    };
    const ids = (db: DB, t: string) => db.all<{ id: string }>(`SELECT id FROM ${t} ORDER BY id`).map((r) => r.id);

    const owner = at25(false, false);
    migrate(owner);
    // «تذكير بالدفعة» من الهجرة ١٥ يُحذف أيضاً · والمعدَّل وقالب المستخدم يبقيان
    expect(ids(owner, 'message_scripts')).toEqual(['MS-SEED-2', 'mine']);
    expect(ids(owner, 'form_templates')).toEqual([]);
    const tomb = owner.all<{ tbl: string; pk: string; op: string }>(`SELECT tbl, pk, op FROM sync_outbox WHERE op = 'delete' ORDER BY tbl, pk`);
    expect(tomb.map((r) => r.tbl + ':' + r.pk)).toEqual(['form_templates:FT-HANDOVER', 'message_scripts:MS-SEED-1', 'message_scripts:MS-SEED-3', 'message_scripts:ms-reminder-default', 'message_scripts:old-random-id']);

    const edited = at25(false, true);
    migrate(edited);
    expect(ids(edited, 'form_templates')).toEqual(['FT-HANDOVER']);

    const member = at25(true, false);
    migrate(member);
    expect(ids(member, 'message_scripts')).toHaveLength(6);
    expect(ids(member, 'form_templates')).toEqual(['FT-HANDOVER']);
  });

  test('عقدٌ ولا قالب ولا تفاصيل للوحدة: لا نموذج فارغاً · وبقالبٍ أنشأه المستخدم يُنشأ منه', async () => {
    const { getContractHandover } = await import('@/domain/handover/service');
    const db = memDb();
    const p = addProperty(db, { name: 'عقار النماذج' });
    const c1 = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'H-1' }), { tenant: 'مستأجر نموذج أول', idNumber: '1000005001', phone: '0500005001' }));
    expect(getContractHandover(db, c1)).toBeUndefined();
    db.run(`INSERT INTO form_templates (id, name, is_system, sections_json, created_at) VALUES ('tpl-mine','قالبي',0,?,'2026-01-01')`,
      [JSON.stringify([{ section: 'الصالة', items: ['كنب', 'ستائر'] }])]);
    const c2 = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'H-2' }), { tenant: 'مستأجر نموذج ثانٍ', idNumber: '1000005002', phone: '0500005002' }));
    const h = getContractHandover(db, c2)!;
    expect(JSON.parse(h.sections_json).map((s: { section: string }) => s.section)).toEqual(['الصالة']);
  });
});
