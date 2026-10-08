/**
 * فحص التطابق بين مشروعي Firebase (القاعدة ٩٥) · مقارنة القواعد بلا شبكة، ومعها خلل مزروع يُسقطها (القاعدة ٤٨).
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { rulesMatch } = require('../scripts/check-firebase-parity.js') as { rulesMatch: (a: string, b: string, block?: string) => boolean };

const BASE = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orgs/{org} { allow read: if false; }
`;
const CHAT = `    // <chat> · كتلة مصطنعة
    match /orgs/{org}/chats/{c} { allow read: if true; }
    // </chat>
`;
const END = `  }
}
`;

test('المطابق يطابق ولو اختلفت الأسطر الفارغة ونهايات الأسطر', () => {
  expect(rulesMatch(BASE + END, (BASE + '\n\n' + END).replace(/\n/g, '\r\n'))).toBe(true);
});

test('خلل مزروع: سطر قاعدة مختلف يُسقط المطابقة', () => {
  expect(rulesMatch(BASE + END, BASE.replace('if false', 'if true') + END)).toBe(false);
});

test('الكتلة المستثناة لا تُحسب على المرجع · وخارجها يُحسب', () => {
  expect(rulesMatch(BASE + END, BASE + CHAT + END, 'chat')).toBe(true);
  expect(rulesMatch(BASE + END, BASE + CHAT + END)).toBe(false);
  expect(rulesMatch(BASE.replace('if false', 'if true') + END, BASE + CHAT + END, 'chat')).toBe(false);
});
