// The whole web app ships inside the binary as one zip asset (see scripts/sync-web.mjs).
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
config.resolver.assetExts = [...config.resolver.assetExts.filter((ext) => ext !== 'zip'), 'zip']

module.exports = config
