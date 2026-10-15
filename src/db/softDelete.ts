/**
 * جداول المزامنة التي فيها حذفٌ ناعم (عمود deleted_at) · العضو لا يحذفها حذفاً نهائياً، والنهائي للمالك من السلة (قرار المالك
 * 2026-10-15 «٨. حذف العضو في أقسامه: الحذف الناعم وحده للعضو») · وما سواها سطورٌ تُستبدل مع تعديل أصلها فتُحذف كما كانت ·
 * ويطابقها مخطط القاعدة (tests/softDelete.test.ts)
 */
export const SOFT_DELETE_TABLES: readonly string[] = ["accounts","cost_centers","tenants","suppliers","banks","properties","units","meters","company_docs","message_scripts","form_templates","journal_entries","contracts","occupants","reservations","key_money_deals","claims","invoices","purchases","bank_tx","handovers","purchase_lines","assets","attachments","vat_filings"];

/**
 * سجلات التحصيل والتسوية تُلغى ولا تُحذف (الدفعة بـ cancelled_at وقيدها العاكس) · فالعضو لا يحذفها حذفاً نهائياً كذلك (قرار المالك
 * 2026-10-15 «٨» · المتحقق المستقل، الجولة ٣٥ (ج٢): كان شاهد حذف العضو على الدفعة يُقبل) · والنهائي من المالك وحده (السلة)
 */
export const CANCEL_ONLY_TABLES: readonly string[] = ['contract_payments', 'payment_lines', 'payment_allocations', 'deposit_settlements', 'tenant_ratings'];

/** ما لا يحذفه العضو حذفاً نهائياً: ما فيه حذفٌ ناعم، وما يُلغى ولا يُحذف */
export const MEMBER_NO_HARD_DELETE: readonly string[] = [...SOFT_DELETE_TABLES, ...CANCEL_ONLY_TABLES];
