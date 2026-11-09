import React, { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { LANGUAGES, type LanguageCode } from '../languages'
import type { DraftPreview } from '../state/useInterpreter'
import type { Speaker as SpeakerId } from '../state/types'
import { Icon } from './components'
import { colors, radius, TOUCH } from './theme'

/** Pause in typing before the draft is translated in the background. */
const PREVIEW_DEBOUNCE_MS = 450

export function Composer({
  langA,
  langB,
  enabled,
  loading,
  voiceAvailable,
  listening,
  preview,
  onPreview,
  onClearPreview,
  onSend,
  onMic,
}: {
  langA: LanguageCode
  langB: LanguageCode
  /** The translation model is loaded. */
  enabled: boolean
  /** The translation model is loading. */
  loading?: boolean
  /** Speech recognition is loaded (shows the mic button). */
  voiceAvailable: boolean
  /** Which speaker is currently being listened to, if any. */
  listening: SpeakerId | null
  preview: DraftPreview | null
  onPreview: (speaker: SpeakerId, text: string) => void
  onClearPreview: () => void
  onSend: (speaker: SpeakerId, text: string) => void
  onMic: (speaker: SpeakerId) => void
}) {
  const [speaker, setSpeaker] = useState<SpeakerId>('A')
  const [text, setText] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const lang = LANGUAGES[speaker === 'A' ? langA : langB]
  const other = LANGUAGES[speaker === 'A' ? langB : langA]
  const accent = speaker === 'A' ? colors.a : colors.b

  const schedulePreview = (sp: SpeakerId, value: string) => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (!value.trim() || !enabled) {
      onClearPreview()
      return
    }
    timer.current = setTimeout(() => {
      timer.current = null
      onPreview(sp, value)
    }, PREVIEW_DEBOUNCE_MS)
  }

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  // Language changes invalidate the preview.
  useEffect(() => {
    schedulePreview(speaker, text)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [langA, langB])

  const choose = (sp: SpeakerId) => {
    if (sp === speaker) return
    setSpeaker(sp)
    schedulePreview(sp, text)
  }

  const send = () => {
    const value = text.trim()
    if (!value || !enabled) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    onSend(speaker, value)
    setText('')
    // In a two-person exchange the other person usually answers next.
    setSpeaker(speaker === 'A' ? 'B' : 'A')
  }

  const showPreview = !!preview && preview.speaker === speaker && preview.text === text.trim() && !!text.trim()
  const pendingPreview = !!text.trim() && enabled && !showPreview

  return (
    <View style={styles.wrap}>
      {showPreview || pendingPreview ? (
        <View style={[styles.preview, { borderLeftColor: accent }]} accessibilityLiveRegion="polite">
          <View style={styles.previewHead}>
            <Text style={styles.previewLabel}>{other.label}</Text>
            {!showPreview || preview?.status === 'translating' ? <ActivityIndicator size="small" color={colors.faint} /> : null}
          </View>
          <Text style={styles.previewText} numberOfLines={4}>
            {showPreview && preview?.translation ? preview.translation : showPreview && preview?.status === 'error' ? 'Could not translate. Press send to try again.' : 'Translating as you type'}
          </Text>
        </View>
      ) : null}

      <View style={styles.switchRow} accessibilityRole="radiogroup">
        {(['A', 'B'] as SpeakerId[]).map((sp) => {
          const l = LANGUAGES[sp === 'A' ? langA : langB]
          const selected = sp === speaker
          const c = sp === 'A' ? colors.a : colors.b
          return (
            <Pressable
              key={sp}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={`Speaker ${sp}, ${l.label}`}
              onPress={() => choose(sp)}
              style={({ pressed }) => [styles.chip, selected && { borderColor: c, backgroundColor: sp === 'A' ? colors.aDim : colors.bDim }, pressed && { opacity: 0.7 }]}
            >
              <View style={[styles.dot, { backgroundColor: c }]} />
              <Text style={[styles.chipText, selected && { color: colors.text }]} numberOfLines={1}>
                {sp} · {l.label}
              </Text>
            </Pressable>
          )
        })}
      </View>

      <View style={[styles.inputRow, { borderColor: accent }]}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={(v) => {
            setText(v)
            schedulePreview(speaker, v)
          }}
          editable={enabled}
          placeholder={enabled ? `Type in ${lang.label}` : loading ? 'Loading translation model' : 'Translation model not loaded'}
          placeholderTextColor={colors.faint}
          accessibilityLabel={`Message from speaker ${speaker} in ${lang.label}`}
          multiline
          keyboardAppearance="dark"
        />
        {voiceAvailable ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={listening === speaker ? 'Stop listening' : `Speak ${lang.label}`}
            onPress={() => onMic(speaker)}
            style={({ pressed }) => [
              styles.iconBtn,
              { backgroundColor: listening === speaker ? accent : speaker === 'A' ? colors.aDim : colors.bDim },
              pressed && { opacity: 0.6 },
            ]}
          >
            <Icon name={listening === speaker ? 'stop' : 'mic'} size={21} color={listening === speaker ? colors.onAccent : accent} />
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          accessibilityState={{ disabled: !text.trim() || !enabled }}
          disabled={!text.trim() || !enabled}
          onPress={send}
          style={({ pressed }) => [styles.sendBtn, { backgroundColor: accent, opacity: !text.trim() || !enabled ? 0.35 : pressed ? 0.75 : 1 }]}
        >
          <Icon name="arrow-up" size={22} color={colors.onAccent} />
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingTop: 8, gap: 8 },
  preview: { backgroundColor: colors.surface, borderRadius: radius.md, borderLeftWidth: 3, paddingHorizontal: 12, paddingVertical: 8 },
  previewHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 },
  previewLabel: { color: colors.faint, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  previewText: { color: colors.text, fontSize: 16, lineHeight: 22 },
  switchRow: { flexDirection: 'row', gap: 8 },
  chip: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  chipText: { color: colors.muted, fontSize: 13, fontWeight: '600', flexShrink: 1 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 6,
  },
  input: { flex: 1, minWidth: 0, color: colors.text, fontSize: 17, lineHeight: 22, minHeight: TOUCH - 8, maxHeight: 120, paddingTop: 8, paddingBottom: 8 },
  iconBtn: { width: TOUCH - 4, height: TOUCH - 4, borderRadius: (TOUCH - 4) / 2, alignItems: 'center', justifyContent: 'center' },
  sendBtn: { width: TOUCH - 4, height: TOUCH - 4, borderRadius: (TOUCH - 4) / 2, alignItems: 'center', justifyContent: 'center' },
})
