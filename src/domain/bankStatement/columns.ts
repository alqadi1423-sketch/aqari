/**
 * قاموس عناوين كشف البنك بالعربية والإنجليزية (الدراسة · «قاموس الأعمدة»): يُطابَق داخل الخلية لا بنصها كله، لأن العناوين ثنائية اللغة
 * («Date التاريخ») · والأخص قبل الأعم: تاريخ القيمة والهجري قبل التاريخ · وكلمات الملخص (الافتتاحي والختامي والمجاميع والفترة).
 */
import { foldText } from './normalize';
import dictionary from './dictionary.json';

export type Role = 'date' | 'valueDate' | 'hijri' | 'descr' | 'debit' | 'credit' | 'amount' | 'balance' | 'ref' | 'type';

// كلمات عناوين الكشوف كما تطبعها البنوك، لا نصوص واجهة · مطبَّعةً بـfoldText (ة ← ه، أ ← ا) في dictionary.json
const DICT = dictionary.roles as Array<[Role, string[]]>;

const AMOUNT_WORDS = DICT.find(([r]) => r === 'amount')?.[1] ?? [];

const hasPhrase = (text: string, phrase: string): boolean => (' ' + text + ' ').includes(' ' + phrase + ' ');

/** دور خلية عنوان، أو null */
export function roleOf(cell: unknown): Role | null {
  const t = foldText(cell);
  if (!t || t.length > 60) return null;
  // «تاريخ القيمة» و«التاريخ الهجري» قبل «التاريخ»، و«تفاصيل العملية» قبل «العملية»
  for (const [role, words] of DICT) {
    if (!words.some((w) => hasPhrase(t, w))) continue;
    // ومؤشر «مدين/دائن» مع كلمة المبلغ عمود مبلغٍ موقَّع لا عمود نوع («Debit/Credit Amount»)
    if (role === 'type' && AMOUNT_WORDS.some((w) => hasPhrase(t, w))) return 'amount';
    return role;
  }
  return null;
}

/** أدوار صفٍّ من الخلايا (null لما لا دور له) · والدور الواحد لأول عمودٍ به (العنوان الثنائي المكرر لا يأخذه عمودان) */
export function headerRoles(cells: unknown[]): Array<Role | null> {
  const seen = new Set<Role>();
  return cells.map((c) => {
    const r = roleOf(c);
    if (!r || seen.has(r)) return null;
    seen.add(r);
    return r;
  });
}

/** carried: «الرصيد المرحَّل» أسفل الصفحة · ختاميٌّ إن لم تأتِ بعده حركة (المدقق الخارجي D٢-٥) */
export type SummaryKey = 'opening' | 'closing' | 'carried' | 'totalDebit' | 'totalCredit' | 'period';

const SUMMARY = dictionary.summary as Array<[SummaryKey, string[]]>;

/** مفتاح ملخصٍ في الخلية، أو null */
export function summaryOf(cell: unknown): SummaryKey | null {
  const t = foldText(cell);
  if (!t) return null;
  for (const [k, words] of SUMMARY) if (words.some((w) => hasPhrase(t, w) || t.startsWith(w + ' '))) return k;
  return null;
}
