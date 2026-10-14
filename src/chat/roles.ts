/**
 * دور المرسل في المحادثة من معرّفه لا من اسمه (المراجعة الخارجية ٧ · النتيجة ١٧ · قرار المالك «رابعاً ١٠» 2026-10-10: «شارة
 * دور مشتقة من المعرّف لا من النص، وقيد على الاسم»): المالك برقم المنشأة، والإشراف من الدليل (تفرضه القواعد من سجل المالك) ·
 * فاسمٌ يكتبه العضو لا يبلغ شارة المالك ولو طابقها نصاً · والشارة تُعرض عنصراً مستقلاً لا نصاً ملحقاً بالاسم
 */
export type ChatRole = { kind: 'owner' } | { kind: 'supervisor'; sections: string[] } | null;

export function roleOf(uid: string, org: string, sup: readonly string[] | null | undefined): ChatRole {
  if (uid === org) return { kind: 'owner' };
  return sup && sup.length ? { kind: 'supervisor', sections: [...sup] } : null;
}

/** المرسل كما يُعرض: اسمه نصاً، ودوره شارةً من معرّفه */
export function senderDisplay(uid: string, org: string, person: { name: string; sup: readonly string[] } | null | undefined, fallback: string): {
  name: string; role: ChatRole;
} {
  return { name: person?.name || fallback, role: roleOf(uid, org, person?.sup) };
}
