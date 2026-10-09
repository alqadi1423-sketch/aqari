/**
 * مراجعة التثبيت #52: دعوة من منشأة غريبة كانت تُعرض قبل منشأة صاحب الحساب على جهاز جديد، فيُخدع ليدخل بياناته منشأة
 * غيره · منشأته القائمة أولاً، وبريد صاحب الدعوة ظاهر · بيانات مصطنعة.
 */
import { inviteChoices } from '@/services/org';

const inv = (org: string, by = '') => ({ org, doc: { email: 'me@example.test', orgName: 'منشأة مصطنعة', invitedBy: by } as never });

test('لصاحب منشأةٍ قائمة: منشأته أولاً ثم الدعوات ببريد أصحابها', () => {
  const c = inviteChoices(true, [inv('ORG-X', 'stranger@example.test')]);
  expect(c.map((x) => x.kind)).toEqual(['own', 'invite']);
  expect(c[1]).toMatchObject({ kind: 'invite', org: 'ORG-X', by: 'stranger@example.test' });
});

test('بلا منشأة قائمة: الدعوات وحدها كما كانت', () => {
  expect(inviteChoices(false, [inv('ORG-X'), inv('ORG-Y')]).map((x) => x.kind)).toEqual(['invite', 'invite']);
});
