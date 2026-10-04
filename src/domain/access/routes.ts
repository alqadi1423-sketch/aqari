/**
 * قسم كل مسار · الحارس في التخطيط الجذري يرجع من مسار قسمه «لا» فلا رابط مباشر يفتحه،
 * و«المزيد» والشريط السفلي يُبنيان منه. المسار الغائب هنا لا يُفتح لعضو (الأصل المنع).
 */
import type { Access } from './access';
import { canView, isAdmin } from './access';
import type { SectionKey } from './sections';

/** null: مسار لكل من دخل (الرئيسية والإعدادات الشخصية) · 'admin': للمالك وحده */
export const ROUTE_SECTION: Record<string, SectionKey | null> = {
  '/': null,
  '/index': null,
  '/properties': 'props',
  '/units': 'props',
  '/propmap': 'props',
  '/contracts': 'contracts',
  '/collect': 'collect',
  '/more': null,
  '/tenants': 'tenants',
  '/suppliers': 'purchases',
  '/purchases': 'purchases',
  '/invoices': 'invoices',
  '/claims': 'claims',
  '/banks': 'banks',
  '/transactions': 'banks',
  '/reports': 'reports',
  '/accounts': 'ledger',
  '/journal': 'ledger',
  '/integrity': 'ledger',
  '/library': 'library',
  '/company': 'company',
  '/scripts': 'company',
  '/form-templates': 'company',
  '/audit-log': 'audit',
  '/perf': 'admin',
  '/settings': null,
};

/** مسار من شجرة expo-router (قد يحمل (tabs)) إلى مفتاح الجدول */
export function normalizeRoute(pathname: string): string {
  const p = ('/' + pathname.split('?')[0].split('#')[0].replace(/\([^)]*\)\/?/g, '').replace(/^\/+/, '')).replace(/\/+$/, '');
  return p === '' ? '/' : p;
}

/** هل يُفتح المسار لمن يستعمل الجهاز · المسار المجهول للمالك وحده */
export function routeAllowed(a: Access, pathname: string): boolean {
  if (a.owner) return true;
  const key = normalizeRoute(pathname);
  if (!(key in ROUTE_SECTION)) return false;
  const sec = ROUTE_SECTION[key];
  if (sec === null) return true;
  if (sec === 'admin') return isAdmin(a);
  return canView(a, sec);
}
