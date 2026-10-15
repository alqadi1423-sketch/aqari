/**
 * جداول المزامنة التي فيها حذفٌ ناعم (عمود deleted_at) · العضو لا يحذفها حذفاً نهائياً، والنهائي للمالك من السلة (قرار المالك
 * 2026-10-15 «٨. حذف العضو في أقسامه: الحذف الناعم وحده للعضو») · وما سواها سطورٌ تُستبدل مع تعديل أصلها فتُحذف كما كانت ·
 * ويطابقها مخطط القاعدة (tests/softDelete.test.ts)
 */
export const SOFT_DELETE_TABLES: readonly string[] = ["accounts","cost_centers","tenants","suppliers","banks","properties","units","meters","company_docs","message_scripts","form_templates","journal_entries","contracts","occupants","reservations","key_money_deals","claims","invoices","purchases","bank_tx","handovers","purchase_lines","assets","attachments","vat_filings"];
