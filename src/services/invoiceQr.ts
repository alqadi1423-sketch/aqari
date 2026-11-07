/**
 * قراءة رموز الصورة (التوجيه الرابع ٦ · ١ · «قراءة فاتورة الشراء بـQR أولاً»): ML Kit للرموز على الجهاز نفسه، بلا شبكة ولا خادم،
 * كقراءة نص العقد (contractScan.ts) · تعيد قيم الرموز كلها، ويختار منها pickZatcaQr رمز الهيئة · وترمي «qr-unavailable» إن غابت
 * الوحدة (حزمةٌ أقدم أو بيئة بلا ML Kit)، و«qr-read» إن تعذّرت قراءة الصورة.
 */
export async function readQrFromImage(uri: string): Promise<string[]> {
  let scan: (u: string) => Promise<Array<{ value: string }>>;
  try {
    const mod = await import('@react-native-ml-kit/barcode-scanning');
    scan = (u) => mod.default.scan(u);
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
  const { qrValuesFromInvoiceFile } = await import('../domain/invoiceFile');
  let bytes: Uint8Array;
  try { bytes = new File(file.uri).bytesSync(); } catch { throw new Error('qr-read'); }
  return qrValuesFromInvoiceFile(bytes, file.name, file.mime);
}
