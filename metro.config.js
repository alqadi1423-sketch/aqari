// إعداد ميترو · امتداد jstxt أصلٌ خام (مكتبة pdf.js تُحقن في WebView نصاً)
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.resolver.assetExts = [...config.resolver.assetExts, 'jstxt'];

module.exports = config;
