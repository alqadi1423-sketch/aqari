/**
 * صفحتا الشروط والخصوصية على استضافة المشروع · تُنشران بعد مراجعة المالك لمسودتيهما.
 * ولا يظهر رابطاهما قبل نشرهما (مراجعة التثبيت #45: رابطٌ مكسور في أول شاشة) · يُقلَب هذا عند النشر وحده.
 */
export const LEGAL_PAGES_PUBLISHED = false;

export function legalUrls(projectId: string | null | undefined): { terms: string; privacy: string } | null {
  if (!LEGAL_PAGES_PUBLISHED || !projectId) return null;
  return { terms: `https://${projectId}.web.app/terms`, privacy: `https://${projectId}.web.app/privacy` };
}
