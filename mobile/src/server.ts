import StaticServer from '@dr.pogodin/react-native-static-server'
import { toServerPath } from './paths'

/**
 * Serves the unpacked web app on localhost. A loopback http origin counts as a secure context,
 * which the camera (getUserMedia) and the WASM runtime require; file:// pages would not work.
 */
export const startWebServer = async (fileDir: string): Promise<{ readonly origin: string; readonly stop: () => Promise<void> }> => {
  const server = new StaticServer({ fileDir: toServerPath(fileDir), hostname: '127.0.0.1', port: 0, stopInBackground: true })
  const origin = await server.start()
  return { origin, stop: () => server.stop() }
}
