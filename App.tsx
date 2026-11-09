import React, { useCallback, useState } from 'react'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { StyleSheet, View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { ConversationScreen } from './src/ui/ConversationScreen'
import { SetupScreen } from './src/ui/SetupScreen'
import { StartupScreen } from './src/ui/StartupScreen'
import { useInterpreter } from './src/state/useInterpreter'
import { colors } from './src/ui/theme'

// Keep the native splash (logo on the app's dark background) up until the animated
// start-up screen has drawn its first frame, so there is never a blank white screen.
SplashScreen.preventAutoHideAsync().catch(() => undefined)

export default function App() {
  const it = useInterpreter()
  const [screen, setScreen] = useState<'conversation' | 'setup'>('conversation')
  const [starting, setStarting] = useState(true)
  const hideSplash = useCallback(() => SplashScreen.hide(), [])
  const started = useCallback(() => setStarting(false), [])
  return (
    <SafeAreaProvider>
      <View style={styles.fill}>
        {/* Keeps the app clear of the status bar and of Android's gesture bar. */}
        <SafeAreaView style={styles.root} edges={['top', 'bottom', 'left', 'right']}>
        <StatusBar style="light" />
        {screen === 'setup' ? (
          <SetupScreen it={it} onBack={() => setScreen('conversation')} />
        ) : (
          <ConversationScreen it={it} onOpenSetup={() => setScreen('setup')} />
        )}
        </SafeAreaView>
        {starting ? <StartupScreen it={it} onLayout={hideSplash} onDone={started} /> : null}
      </View>
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  root: { flex: 1, backgroundColor: colors.bg },
})
