/**
 * قرار المالك 2026-10-08: «مسحي الشامل: يمسح محادثات المنشأة من أجهزة الأعضاء عند أول اتصال، بنسخة أمان وسطر في سجل
 * العمليات.» · بيانات مصطنعة
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { memDb } from './helpers/testDb';
import { clearChatData, hasChatData, openDirect, sendLocal } from '@/chat';
import { chatWipeDue } from '@/services/org';
import { getSyncState, setSyncState } from '@/sync/engine';

test('مسح المحادثات: الرسائل ومحادثاتها وحالها ومؤشرات سحبها · والرسالة تبقى لا تُحذف بعده', () => {
  const db = memDb();
  const t = openDirect(db, 'u-a', 'u-b');
  sendLocal(db, t, { uid: 'u-a', name: 'عضو مصطنع' }, 'رسالة مصطنعة');
  setSyncState(db, 'chat_full_at', '1');
  setSyncState(db, 'chat_epoch', '1');
  expect(hasChatData(db)).toBe(true);
  expect(clearChatData(db)).toBe(1);
  expect(hasChatData(db)).toBe(false);
  expect(getSyncState(db, 'chat_full_at')).toBeNull();
  expect(getSyncState(db, 'chat_epoch')).toBe('1');
  // حارس «الرسالة لا تُحذف» قائم بعد المسح
  const t2 = openDirect(db, 'u-a', 'u-c');
  const m = sendLocal(db, t2, { uid: 'u-a', name: 'عضو مصطنع' }, 'بعد المسح');
  expect(() => db.run(`DELETE FROM chat_messages WHERE id = ?`, [m])).toThrow('chat message is permanent');
  db.close();
});

test('يحين المسح بعهدٍ في الخادم بعد آخر ما مُسح عنده أو اعتمده الجهاز، وعليه محادثات', () => {
  expect(chatWipeDue(1, 2, true)).toBe(true);
  expect(chatWipeDue(2, 2, true)).toBe(false);
  expect(chatWipeDue(null, 1, true)).toBe(true);
  expect(chatWipeDue(1, 2, false)).toBe(false);
});

test('في المزامنة: الأساس قبل فحص العهد · ونسخة الأمان قبل المسح والمحادثة موقوفة · وسطرٌ في سجل العمليات · وقبل سؤال البيانات', () => {
  const src = readFileSync(join(__dirname, '..', 'src/services/cloud.ts'), 'utf8');
  const i = src.indexOf('const chatBase = chatEpochBaseline(db);');
  const check = src.indexOf('await checkEpoch(', i);
  const hold = src.indexOf('await holdChat(async () => {', check);
  const backup = src.indexOf("await makeSafetyBackup(appBackupEnv(db as AppDB), 'pre-wipe');", hold);
  const clear = src.indexOf('const n = clearChatData(db);', backup);
  const audit = src.indexOf("logAudit(db, 'المحادثة', 'delete', 'مسح محادثات المنشأة'", clear);
  const ask = src.indexOf("if (act === 'ask') { patch({ decision: { kind: 'epoch'", audit);
  expect([i, check, hold, backup, clear, audit, ask].every((x) => x > 0)).toBe(true);
});
