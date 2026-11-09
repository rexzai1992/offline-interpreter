import React, { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Animated, Easing, Image, StyleSheet, Text, View } from 'react-native'
import { HY_MT2_Q4_K_M, SILERO_VAD } from '../models/catalog'
import type { Interpreter } from '../state/useInterpreter'
import { Icon } from './components'
import { colors } from './theme'

/** Shown at least this long, so a fast start does not flash. */
const MIN_VISIBLE_MS = 1200
/** Never hold the app longer than this; the status line takes over after. */
const MAX_VISIBLE_MS = 25000

type StepState = 'waiting' | 'loading' | 'ready' | 'missing' | 'error'

/**
 * Animated start-up screen shown over the app while the on-device engines load: the logo
 * floats inside two pulsing rings in the speaker colours, and a short checklist shows what
 * is getting ready. It fades out once every installed engine has loaded (or failed).
 */
export function StartupScreen({ it, onLayout, onDone }: { it: Interpreter; onLayout?: () => void; onDone: () => void }) {
  const [fade] = useState(() => new Animated.Value(1))
  const [float] = useState(() => new Animated.Value(0))
  const [ringA] = useState(() => new Animated.Value(0))
  const [ringB] = useState(() => new Animated.Value(0))
  const [sweep] = useState(() => new Animated.Value(0))
  const [shownAt] = useState(() => Date.now())
  const [timedOut, setTimedOut] = useState(false)
  const leaving = useRef(false)

  useEffect(() => {
    const loops = [
      Animated.loop(
        Animated.sequence([
          Animated.timing(float, { toValue: 1, duration: 1400, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
          Animated.timing(float, { toValue: 0, duration: 1400, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        ]),
      ),
      Animated.loop(Animated.timing(ringA, { toValue: 1, duration: 2400, easing: Easing.out(Easing.quad), useNativeDriver: true })),
      Animated.loop(Animated.sequence([Animated.delay(1200), Animated.timing(ringB, { toValue: 1, duration: 2400, easing: Easing.out(Easing.quad), useNativeDriver: true })])),
      Animated.loop(Animated.timing(sweep, { toValue: 1, duration: 1300, easing: Easing.inOut(Easing.quad), useNativeDriver: true })),
    ]
    loops.forEach((l) => l.start())
    const t = setTimeout(() => setTimedOut(true), MAX_VISIBLE_MS)
    return () => {
      loops.forEach((l) => l.stop())
      clearTimeout(t)
    }
  }, [float, ringA, ringB, sweep])

  const { status, settingsLoaded, modelStatus } = it
  const translatorFile = modelStatus[HY_MT2_Q4_K_M.id]?.state
  const voiceFile = modelStatus[SILERO_VAD.id]?.state
  const translation = stepState(translatorFile, status.translator.state)
  const voice = stepState(voiceFile, status.asr.state)
  const busy = !settingsLoaded || translation === 'waiting' || translation === 'loading' || voice === 'waiting' || voice === 'loading'
  const done = !busy || timedOut

  useEffect(() => {
    if (!done || leaving.current) return
    const wait = Math.max(0, MIN_VISIBLE_MS - (Date.now() - shownAt))
    const t = setTimeout(() => {
      leaving.current = true
      Animated.timing(fade, { toValue: 0, duration: 380, easing: Easing.out(Easing.quad), useNativeDriver: true }).start(() => onDone())
    }, wait)
    return () => clearTimeout(t)
  }, [done, fade, onDone, shownAt])

  const progress = status.translator.state === 'loading' ? status.translator.progress : null
  const ring = (v: Animated.Value, color: string) => (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.ring,
        { borderColor: color, opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }), transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.75, 1.7] }) }] },
      ]}
    />
  )

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.root, { opacity: fade }]} onLayout={onLayout} accessibilityLabel="Getting ready" accessibilityLiveRegion="polite">
      {/* The logo sits at the exact screen centre, where the native splash drew it, so the
          hand-over from the splash is seamless; the text hangs below it. */}
      <View style={styles.logoLayer} pointerEvents="none">
        <View style={styles.logoWrap}>
          {ring(ringA, colors.a)}
          {ring(ringB, colors.b)}
          <Animated.View style={{ transform: [{ translateY: float.interpolate({ inputRange: [0, 1], outputRange: [5, -5] }) }] }}>
            <Image source={require('../../assets/splash-icon.png')} style={styles.logo} resizeMode="contain" accessibilityIgnoresInvertColors />
          </Animated.View>
        </View>
      </View>
      <View style={styles.below}>
        <Text style={styles.title}>Interpreter</Text>
        <Text style={styles.subtitle}>Two languages, one conversation</Text>

        <View style={styles.steps}>
          <Step label="Translation model" state={translation} detail={progress != null && progress > 0 && progress < 100 ? `${Math.round(progress)}%` : undefined} />
          <Step label="Voice recognition" state={voice} />
        </View>

        <View style={styles.track}>
          <Animated.View style={[styles.sweep, { transform: [{ translateX: sweep.interpolate({ inputRange: [0, 1], outputRange: [-90, 220] }) }] }]} />
        </View>
      </View>
      <Text style={styles.footer}>Everything runs on this phone. Nothing is uploaded.</Text>
    </Animated.View>
  )
}

function stepState(file: string | undefined, engine: string): StepState {
  if (engine === 'ready') return 'ready'
  if (engine === 'error') return 'error'
  if (engine === 'loading') return 'loading'
  if (file === 'ready') return 'waiting'
  if (file === 'verifying') return 'loading'
  return 'missing'
}

function Step({ label, state, detail }: { label: string; state: StepState; detail?: string }) {
  const text =
    state === 'ready' ? 'Ready' : state === 'loading' ? (detail ?? 'Loading') : state === 'waiting' ? 'Waiting' : state === 'missing' ? 'Not downloaded yet' : 'Could not load'
  return (
    <View style={styles.step} accessibilityLabel={`${label}: ${text}`}>
      <View style={styles.stepIcon}>
        {state === 'ready' ? (
          <Icon name="checkmark-circle" size={18} color={colors.ok} />
        ) : state === 'loading' || state === 'waiting' ? (
          <ActivityIndicator size="small" color={state === 'loading' ? colors.a : colors.faint} />
        ) : state === 'error' ? (
          <Icon name="alert-circle" size={18} color={colors.danger} />
        ) : (
          <Icon name="ellipse-outline" size={16} color={colors.faint} />
        )}
      </View>
      <Text style={styles.stepLabel}>{label}</Text>
      <Text style={[styles.stepState, state === 'ready' && { color: colors.ok }, state === 'error' && { color: colors.danger }]}>{text}</Text>
    </View>
  )
}

// The icon image has generous transparent padding; the bubbles fill about half of it.
const LOGO = 210
const styles = StyleSheet.create({
  root: { backgroundColor: colors.bg, justifyContent: 'flex-end', paddingHorizontal: 32, paddingBottom: 28, zIndex: 10 },
  logoLayer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  below: { position: 'absolute', top: '50%', left: 32, right: 32, marginTop: 124, alignItems: 'center' },
  logoWrap: { width: 240, height: 220, alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', width: 160, height: 160, borderRadius: 80, borderWidth: 2 },
  logo: { width: LOGO, height: LOGO },
  title: { color: colors.text, fontSize: 28, fontWeight: '800', letterSpacing: 0.3 },
  subtitle: { color: colors.muted, fontSize: 14, marginTop: 6 },
  steps: { marginTop: 34, width: '100%', maxWidth: 320, gap: 12 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepIcon: { width: 22, alignItems: 'center' },
  stepLabel: { color: colors.text, fontSize: 15, flex: 1 },
  stepState: { color: colors.faint, fontSize: 13 },
  track: { marginTop: 30, width: 220, height: 3, borderRadius: 2, backgroundColor: colors.surface2, overflow: 'hidden' },
  sweep: { width: 90, height: 3, borderRadius: 2, backgroundColor: colors.a },
  footer: { color: colors.faint, fontSize: 12, textAlign: 'center' },
})
