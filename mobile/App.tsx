import { useCameraPermissions, useMicrophonePermissions } from 'expo-camera'
import { StatusBar } from 'expo-status-bar'
import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native'
import { WebView } from 'react-native-webview'
import { ensureWebRoot, type ExtractProgress } from './src/bundle'
import { startWebServer } from './src/server'

type Phase = { readonly kind: 'preparing'; readonly progress: ExtractProgress | null } | { readonly kind: 'ready'; readonly origin: string } | { readonly kind: 'error'; readonly message: string }

const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//

export default function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'preparing', progress: null })
  const [camera, requestCamera] = useCameraPermissions()
  const [microphone, requestMicrophone] = useMicrophonePermissions()
  const stopRef = useRef<(() => Promise<void>) | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (attempt > 0) setPhase({ kind: 'preparing', progress: null })
      try {
        const dir = await ensureWebRoot((progress) => {
          if (!cancelled) setPhase({ kind: 'preparing', progress })
        })
        const server = await startWebServer(dir)
        if (cancelled) {
          await server.stop()
          return
        }
        stopRef.current = server.stop
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
    if (camera && !camera.granted && camera.canAskAgain) requestCamera().catch(() => undefined)
  }, [camera, requestCamera])
  useEffect(() => {
    if (camera?.granted && microphone && !microphone.granted && microphone.canAskAgain) requestMicrophone().catch(() => undefined)
  }, [camera, microphone, requestMicrophone])

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
        style={styles.fill}
        containerStyle={styles.fill}
        source={{ uri: `${phase.origin}/index.html` }}
        originWhitelist={['*']}
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
