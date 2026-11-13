/**
 * قراءة رموز الصورة (التوجيه الرابع ٦ · ١ · «قراءة فاتورة الشراء بـQR أولاً»): ML Kit للرموز على الجهاز نفسه · الصورة ونصها لا يخرجان
 * من الجوال، لكن المكتبة ترسل إلى قوقل بيانات استعمالٍ تقنية (الجهاز والتطبيق ومعرّف التثبيت والأحداث · المراجعة الشاملة 2026-11-13
 * · F-2) وتُستبدل في خطة الخروج من قوقل · كقراءة نص العقد (contractScan.ts) · تعيد قيم الرموز كلها، ويختار منها pickZatcaQr رمز الهيئة · وترمي «qr-unavailable» إن غابت
 * الوحدة (حزمةٌ أقدم أو بيئة بلا ML Kit)، و«qr-read» إن تعذّرت قراءة الصورة.
 */
export async function readQrFromImage(uri: string): Promise<string[]> {
  let scan: (u: string) => Promise<Array<{ value: string }>>;
  try {
    const mod = await import('@react-native-ml-kit/barcode-scanning');
    // والوحدة غير المربوطة (حزمةٌ أقدم أصلاً) يستورد جزؤها المكتوب ويرمي عند أول وصولٍ لخاصية: يُطلب هنا لا عند الاستدعاء (المدقق
    // الخارجي J٩: كان يُقال «جرّب صورةً أوضح» بدل «حدّث التطبيق»)
    const fn = mod.default.scan;
    if (typeof fn !== 'function') throw new Error('qr-unavailable');
    scan = (u) => fn(u);
  } catch {
    throw new Error('qr-unavailable');
  }
  let codes: Array<{ value: string }>;
  // والوحدة موجودة والصورة لا تُقرأ: سببٌ آخر غير الغياب
  try { codes = await scan(uri); } catch { throw new Error('qr-read'); }
  return codes.map((c) => String(c?.value ?? '')).filter(Boolean);
}

/** قيم الرموز في ملف فاتورة إلكترونية (XML، أو PDF يضمّنه) على الجهاز · لا شبكة (domain/invoiceFile.ts) */
export async function readQrFromInvoiceFile(file: { uri: string; name: string; mime: string }): Promise<string[]> {
  const { File } = await import('expo-file-system');
  const { qrValuesFromInvoiceFile, invoiceFileKind } = await import('../domain/invoiceFile');
  let bytes: Uint8Array;
  try { bytes = new File(file.uri).bytesSync(); } catch { throw new Error('qr-read'); }
  // والإشعار الدائن ليس فاتورة شراء (المدقق الخارجي J٦)
  if (invoiceFileKind(bytes, file.name, file.mime) === 'credit') throw new Error('qr-credit');
  return qrValuesFromInvoiceFile(bytes, file.name, file.mime);
}
