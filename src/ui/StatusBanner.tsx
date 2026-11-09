import React from 'react'
import { Pressable, StyleSheet, Text } from 'react-native'
import type { Interpreter } from '../state/useInterpreter'
import { LANGUAGES } from '../languages'
import { Icon, type IconName } from './components'
import { colors } from './theme'

/**
 * One-line processing status for the Conversation screen. Green = everything
 * ready; amber = loading or degraded; red = needs attention. Tapping opens
 * Setup, which has the detailed per-engine block.
 */
export function StatusLine({ it, onPress }: { it: Interpreter; onPress: () => void }) {
  const { status, settings, voiceSupport } = it
  const mt = status.translator
  const asr = status.asr
  const voiceA = voiceSupport?.[settings.langA]
  const voiceB = voiceSupport?.[settings.langB]

  let tone: string = colors.ok
  let icon: IconName = 'checkmark-circle'
  let text = it.onlineAsr ? 'Ready. Voice via Groq (online), translation on-device' : status.offline ? 'Ready. On-device, no network' : 'Ready'
  if (mt.state === 'error') {
    tone = colors.danger
    icon = 'alert-circle'
    text = mt.message
  } else if (asr.state === 'error') {
    tone = colors.danger
    icon = 'alert-circle'
    text = asr.message
  } else if (mt.state === 'loading') {
    tone = colors.warn
    icon = 'hourglass-outline'
    text = `Loading translation model ${Math.round(mt.progress)}%`
  } else if (asr.state === 'loading') {
    tone = colors.warn
    icon = 'hourglass-outline'
    text = 'Loading speech recognition'
  } else if (mt.state !== 'ready') {
    tone = colors.warn
    icon = 'cloud-download-outline'
    text = 'Translation model not installed. Open Setup'
  } else if (asr.state !== 'ready') {
    tone = colors.warn
    icon = 'mic-off-outline'
    text = 'Voice input not installed. Typing works'
  } else if (status.speaking) {
    tone = colors.a
    icon = 'volume-high-outline'
    text = 'Speaking'
  } else if (!it.muted && (!voiceA || !voiceB)) {
    tone = colors.warn
    icon = 'volume-mute-outline'
    const missing = [!voiceA && LANGUAGES[settings.langA].label, !voiceB && LANGUAGES[settings.langB].label].filter(Boolean).join(', ')
    text = `No voice for ${missing}. Text only`
  } else if (!it.muted && (voiceA?.offline !== 'yes' || voiceB?.offline !== 'yes')) {
    tone = colors.warn
    icon = 'cloud-outline'
    text = 'Ready. A voice may need voice data (see Setup)'
  }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Status: ${text}. Opens Setup`}
      hitSlop={4}
      style={({ pressed }) => [styles.wrap, pressed && { opacity: 0.7 }]}
    >
      <Icon name={icon} size={15} color={tone} />
      <Text style={[styles.text, { color: tone === colors.ok ? colors.muted : tone }]} numberOfLines={1}>
        {text}
      </Text>
      {status.lastMt ? (
        <Text style={styles.stats} numberOfLines={1} accessibilityLabel="Last translation timing">
          {(status.lastMt.promptMs / 1000).toFixed(1)}s + {(status.lastMt.generateMs / 1000).toFixed(1)}s
        </Text>
      ) : null}
      <Icon name="chevron-forward" size={13} color={colors.faint} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, minHeight: 40 },
  text: { flex: 1, fontSize: 12 },
  stats: { color: colors.faint, fontSize: 11, fontVariant: ['tabular-nums'] },
})
