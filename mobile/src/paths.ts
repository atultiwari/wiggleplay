/** expo-file-system hands out file:// URIs; the native static server wants a plain absolute path. */
export const toServerPath = (uri: string): string => decodeURIComponent(uri.replace(/^file:\/\//, '')).replace(/\/+$/, '')
