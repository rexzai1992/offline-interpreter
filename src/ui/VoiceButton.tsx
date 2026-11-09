import React, { useEffect, useState } from 'react'
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native'
import { Icon } from './components'
import { colors } from './theme'

const SIZE = 64

/**
 * The main voice control: a large round microphone in the middle of the bottom bar. Tap to
 * start a hands-free conversation (both people just talk); while it listens it turns green,
 * shows a stop square, and two rings pulse outward while the core swells with the voice.
 */
export function VoiceButton({
  active,
  disabled,
  level,
  onPress,
}: {
  active: boolean
  disabled?: boolean
  /** Microphone level, roughly 0 to 0.25 while someone talks. */
  level: number
  onPress: () => void
}) {
  const [pulseA] = useState(() => new Animated.Value(0))
  const [pulseB] = useState(() => new Animated.Value(0))
  const [swell] = useState(() => new Animated.Value(0))

  useEffect(() => {
    if (!active) {
      pulseA.setValue(0)
      pulseB.setValue(0)
      return undefined
    }
    const loops = [
      Animated.loop(Animated.timing(pulseA, { toValue: 1, duration: 1800, easing: Easing.out(Easing.quad), useNativeDriver: true })),
      Animated.loop(Animated.sequence([Animated.delay(900), Animated.timing(pulseB, { toValue: 1, duration: 1800, easing: Easing.out(Easing.quad), useNativeDriver: true })])),
    ]
    loops.forEach((l) => l.start())
    return () => loops.forEach((l) => l.stop())
  }, [active, pulseA, pulseB])

  useEffect(() => {
    // Follow the voice: louder speech makes the glow behind the button swell.
    Animated.spring(swell, { toValue: active ? Math.min(1, level * 5) : 0, speed: 40, bounciness: 0, useNativeDriver: true }).start()
  }, [active, level, swell])

  const tint = active ? colors.b : colors.a
  const ring = (v: Animated.Value) => (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.ring,
        { borderColor: tint, opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }), transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, 1.42] }) }] },
      ]}
    />
  )

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={active ? 'Stop the voice conversation' : 'Start a voice conversation. Both people can just talk.'}
      accessibilityState={{ disabled: !!disabled, selected: active }}
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      style={({ pressed }) => [styles.wrap, { opacity: disabled ? 0.4 : 1 }, pressed && { transform: [{ scale: 0.94 }] }]}
    >
      <View style={styles.stage}>
        {active ? ring(pulseA) : null}
        {active ? ring(pulseB) : null}
        <Animated.View
          pointerEvents="none"
          style={[styles.glow, { backgroundColor: tint, opacity: swell.interpolate({ inputRange: [0, 1], outputRange: active ? [0.18, 0.45] : [0.14, 0.14] }), transform: [{ scale: swell.interpolate({ inputRange: [0, 1], outputRange: [1.06, 1.32] }) }] }]}
        />
        <View style={[styles.core, { backgroundColor: tint }]}>
          <Icon name={active ? 'stop' : 'mic'} size={active ? 24 : 30} color={colors.onAccent} />
        </View>
      </View>
      <Text style={[styles.label, active && { color: colors.b }]} numberOfLines={1}>
        {active ? 'Listening' : 'Talk'}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', minWidth: 96 },
  stage: { width: SIZE + 30, height: SIZE + 22, alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', width: SIZE, height: SIZE, borderRadius: SIZE / 2, borderWidth: 2 },
  glow: { position: 'absolute', width: SIZE, height: SIZE, borderRadius: SIZE / 2 },
  core: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  label: { color: colors.muted, fontSize: 12, fontWeight: '600', marginTop: 2 },
})
