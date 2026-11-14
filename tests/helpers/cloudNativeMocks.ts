/**
 * بدائل وحدات الجهاز لتحميل طبقة الربط الحقيقية (src/services/cloud.ts) على Node · تُستورد قبلها في ملف الاختبار ·
 * قوقل هنا لا يعمل أبداً: كل نداءٍ له يُسجَّل في mockGoogleCalls فيُثبت الاختبار أن مزوّداً آخر لا يمرّ به.
 */
export const mockKv = new Map<string, string>();
export const mockGoogleCalls: string[] = [];

jest.mock('react-native', () => ({
  Platform: { OS: 'android' }, NativeModules: {},
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => mockKv.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { mockKv.set(k, v); },
  deleteItemAsync: async (k: string) => { mockKv.delete(k); },
}));
jest.mock('expo-network', () => ({ getNetworkStateAsync: async () => ({ isConnected: true, isInternetReachable: true }), addNetworkStateListener: () => ({ remove: () => {} }) }));
jest.mock('expo-file-system', () => {
  class F {
    uri: string;
    constructor(...p: unknown[]) { this.uri = p.map((x) => (typeof x === 'string' ? x : (x as { uri?: string })?.uri ?? '')).join('/'); }
    get exists() { return false; }
    get size() { return 0; }
    bytesSync() { return new Uint8Array(); }
    write() {} delete() {} create() {} textSync() { return ''; }
  }
  return { File: F, Directory: F, Paths: { document: { uri: '/doc' }, cache: { uri: '/cache' } } };
});
jest.mock('expo-file-system/legacy', () => ({ FileSystemUploadType: { BINARY_CONTENT: 0 }, getFreeDiskStorageAsync: async () => 1e12 }));
jest.mock('@react-native-google-signin/google-signin', () => {
  const call = (n: string) => async () => { mockGoogleCalls.push(n); throw new Error('google ' + n); };
  return {
    GoogleSignin: {
      configure: () => { mockGoogleCalls.push('configure'); },
      getTokens: call('getTokens'), signInSilently: call('signInSilently'), addScopes: call('addScopes'), hasPlayServices: call('hasPlayServices'),
      signIn: call('signIn'), signOut: call('signOut'), revokeAccess: call('revokeAccess'),
    },
    isSuccessResponse: () => false,
  };
});
jest.mock('expo-crypto', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  getRandomBytes: (n: number) => new Uint8Array(require('node:crypto').randomBytes(n)),
  digest: async () => new ArrayBuffer(32), CryptoDigestAlgorithm: {},
}));
jest.mock('expo-document-picker', () => ({}));
jest.mock('expo-image-manipulator', () => ({}));
jest.mock('expo-local-authentication', () => ({ SecurityLevel: { NONE: 0 }, getEnrolledLevelAsync: async () => 0, authenticateAsync: async () => ({ success: false }) }));
jest.mock('expo-notifications', () => ({ cancelAllScheduledNotificationsAsync: async () => {}, setNotificationHandler: () => {} }));
jest.mock('expo-print', () => ({}));
jest.mock('expo-sharing', () => ({}));
jest.mock('expo-sqlite', () => ({}));
jest.mock('@/services/notifications', () => ({ cancelAllNotifications: async () => {}, rescheduleAllNotifications: async () => {} }));
jest.mock('@/services/appLockService', () => ({ whilePrompting: (f: () => unknown) => f() }));
jest.mock('@/files/expoFs', () => {
  const nodeFs = jest.requireActual('@/files/nodeFs');
  return { expoFs: nodeFs.nodeFs, expoHasher: nodeFs.nodeHasher, appDataRoot: () => '/doc', expoMd5Base64: async () => '' };
});
