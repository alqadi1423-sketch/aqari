/** خادم المحادثة (ق٠-٧) · منطقٌ خالص يُختبر على Node ويُنقل إلى كائن المنشأة الدائم في ق٢ (server.ts) · فحوص كتلة «<chat>» في rules.ts */
export * from './server';
export * from './rules';
export { MemoryAuthStorage as MemoryChatStorage } from '../auth/storage';
