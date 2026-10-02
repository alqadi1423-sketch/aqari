/** الهوية البصرية · تُنقل من النموذج */
export const C = {
  ink: '#10192E',
  ink2: '#182541',
  paper: '#F6F4EE',
  paperLine: 'rgba(16,25,46,0.06)',
  card: '#FFFFFF',
  emerald: '#1E6E5C',
  emeraldSoft: '#E4F0EC',
  gold: '#B08D3D',
  goldSoft: '#F3ECDA',
  rose: '#AE4438',
  roseSoft: '#F7E9E6',
  blue: '#3A5A9C',
  blueSoft: '#E9EEF6',
  charcoal: '#232A36',
  muted: '#77808F',
  line: '#E4E1D8',
} as const;

export const FONT = 'IBMPlexSansArabic_400Regular';
export const FONT_MED = 'IBMPlexSansArabic_500Medium';
export const FONT_BOLD = 'IBMPlexSansArabic_700Bold';

export const RADIUS = 10;

/**
 * نظام المقاييس الواحد · ستة أحجام لا سابع لها، وكل نص في الواجهة يقرأ منها:
 * screenTitle عنوان الشاشة · sectionTitle عنوان القسم · cardTitle عنوان البطاقة ·
 * body النص · caption النص الثانوي والتسميات · number الأرقام والمبالغ.
 */
export const TYPE = {
  screenTitle: 17,
  sectionTitle: 13,
  cardTitle: 12.5,
  body: 12,
  caption: 10.5,
  number: 13.5,
} as const;

/** حالة الشارات · نفس فئات النموذج */
export const BADGE_STYLES: Record<string, { bg: string; fg: string }> = {
  paid: { bg: C.emeraldSoft, fg: C.emerald },
  due: { bg: C.goldSoft, fg: '#8C6C24' },
  overdue: { bg: C.roseSoft, fg: C.rose },
  draft: { bg: '#EEEEEE', fg: '#777777' },
};

export const TYPE_TAG_STYLES: Record<string, { bg: string; fg: string }> = {
  'أصل': { bg: '#E4F0EC', fg: C.emerald },
  'خصم': { bg: '#F7E9E6', fg: C.rose },
  'حقوق ملكية': { bg: '#EFEAF7', fg: '#6947A8' },
  'إيراد': { bg: '#F3ECDA', fg: '#8C6C24' },
  'مصروف': { bg: '#E9EEF6', fg: C.blue },
};
