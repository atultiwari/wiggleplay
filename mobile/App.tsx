import Constants from 'expo-constants'
import { useCameraPermissions, useMicrophonePermissions } from 'expo-camera'
import { StatusBar } from 'expo-status-bar'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Linking, Platform, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import { ensureWebRoot, type ExtractProgress } from './src/bundle'
import { bridgeScript, parseHostCall, replyScript, statusScript } from './src/host-bridge'
import { startWebServer } from './src/server'
import { activeBundle, MobileUpdater } from './src/updates'

type Phase = { readonly kind: 'preparing'; readonly progress: ExtractProgress | null } | { readonly kind: 'ready'; readonly origin: string } | { readonly kind: 'error'; readonly message: string }

const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//
const UPDATE_SITE = 'https://atultiwari.github.io/'
const KIND = Platform.OS === 'ios' ? 'ios' : 'android'
const APP_VERSION = Constants.expoConfig?.version ?? '0.0.0'
const AUTO_CHECK_DELAY_MS = 4000

export default function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'preparing', progress: null })
  const [camera, requestCamera] = useCameraPermissions()
  const [microphone, requestMicrophone] = useMicrophonePermissions()
  const stopRef = useRef<(() => Promise<void>) | null>(null)
  const webRef = useRef<WebView | null>(null)
  const updaterRef = useRef<MobileUpdater | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (attempt > 0) setPhase({ kind: 'preparing', progress: null })
      try {
        await ensureWebRoot((progress) => {
          if (!cancelled) setPhase({ kind: 'preparing', progress })
        })
        const active = await activeBundle()
        const server = await startWebServer(active.dir)
        if (cancelled) {
          await server.stop()
          return
        }
        stopRef.current = server.stop
        updaterRef.current = new MobileUpdater(active.version, (status) => webRef.current?.injectJavaScript(statusScript(status)))
        setPhase({ kind: 'ready', origin: server.origin })
      } catch (error) {
        if (!cancelled) setPhase({ kind: 'error', message: error instanceof Error ? error.message : 'Something went wrong while unpacking the games.' })
      }
    })()
    return () => {
      cancelled = true
      stopRef.current?.().catch(() => undefined)
      stopRef.current = null
    }
  }, [attempt])

  useEffect(() => {
    if (phase.kind !== 'ready') return
    const timer = setTimeout(() => updaterRef.current?.check().catch(() => undefined), AUTO_CHECK_DELAY_MS)
    return () => clearTimeout(timer)
  }, [phase.kind])

  useEffect(() => {
    if (camera && !camera.granted && camera.canAskAgain) requestCamera().catch(() => undefined)
  }, [camera, requestCamera])
  useEffect(() => {
    if (camera?.granted && microphone && !microphone.granted && microphone.canAskAgain) requestMicrophone().catch(() => undefined)
  }, [camera, microphone, requestMicrophone])

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    const call = parseHostCall(event.nativeEvent.data)
    const updater = updaterRef.current
    if (!call || !updater) return
    const reply = (result: unknown, error?: string) => webRef.current?.injectJavaScript(replyScript(call.id, result, error))
    const run = async () => {
      switch (call.method) {
        case 'status':
          return reply(updater.getStatus())
        case 'check':
          return reply(await updater.check())
        case 'download':
          return reply(await updater.download())
        case 'apply':
          reply(null)
          return setAttempt((n) => n + 1)
        case 'open':
          if (call.url?.startsWith(UPDATE_SITE)) await Linking.openURL(call.url)
          return
        default:
          return
      }
    }
    run().catch((error: unknown) => reply(null, error instanceof Error ? error.message : 'Something went wrong.'))
  }, [])

  if (phase.kind === 'error') {
    return (
      <View style={styles.screen}>
        <Text style={styles.title}>Oops!</Text>
        <Text style={styles.text}>{phase.message}</Text>
        <Pressable style={styles.button} onPress={() => setAttempt((n) => n + 1)}>
          <Text style={styles.buttonText}>Try again</Text>
        </Pressable>
      </View>
    )
  }

  if (phase.kind === 'preparing') {
    const p = phase.progress
    return (
      <View style={styles.screen}>
        <StatusBar hidden />
        <ActivityIndicator size="large" color="#3ddc84" />
        <Text style={styles.title}>WigglePlay</Text>
        <Text style={styles.text}>{p ? `Unpacking the games… ${Math.round((p.done / p.total) * 100)}%` : 'Waking up the wiggle magic…'}</Text>
        <Text style={styles.note}>This happens once. After that the games work without the internet.</Text>
      </View>
    )
  }

  return (
    <SafeAreaView style={styles.page}>
      <StatusBar hidden />
      <WebView
        key={phase.origin}
        ref={webRef}
        style={styles.fill}
        containerStyle={styles.fill}
        source={{ uri: `${phase.origin}/index.html` }}
        originWhitelist={['*']}
        injectedJavaScriptBeforeContentLoaded={bridgeScript(KIND, APP_VERSION)}
        onMessage={onMessage}
        onShouldStartLoadWithRequest={(request) => LOCAL.test(request.url)}
        onError={(event) => setPhase({ kind: 'error', message: `The games page could not be shown (${event.nativeEvent.description}).` })}
        onHttpError={(event) => setPhase({ kind: 'error', message: `The games page answered with an error (${event.nativeEvent.statusCode}).` })}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        mediaCapturePermissionGrantType="grant"
        allowsFullscreenVideo
        javaScriptEnabled
        domStorageEnabled
        setSupportMultipleWindows={false}
        allowsBackForwardNavigationGestures={false}
        bounces={false}
        overScrollMode="never"
        webviewDebuggingEnabled={__DEV__}
        cacheEnabled
      />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#1b1533', alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  page: { flex: 1, backgroundColor: '#fff7ef' },
  fill: { flex: 1, width: '100%', height: '100%', backgroundColor: '#fff7ef' },
  title: { color: '#ffffff', fontSize: 32, fontWeight: '800' },
  text: { color: '#e9e4ff', fontSize: 18, textAlign: 'center' },
  note: { color: '#b8b0d6', fontSize: 14, textAlign: 'center' },
  button: { marginTop: 12, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 999, backgroundColor: '#7c5cff' },
  buttonText: { color: '#ffffff', fontSize: 18, fontWeight: '700' },
})
