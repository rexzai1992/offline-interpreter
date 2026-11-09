import React, { useState } from 'react'
import * as Clipboard from 'expo-clipboard'
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { LANGUAGES, type LanguageCode } from '../languages'
import type { Turn } from '../state/types'
import { Button, Icon, Spinner, type IconName } from './components'
import { colors, radius, TOUCH } from './theme'

function ActionIcon({ icon, label, onPress, disabled, tint }: { icon: IconName; label: string; onPress: () => void; disabled?: boolean; tint?: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.action, { opacity: disabled ? 0.3 : pressed ? 0.5 : 1 }]}
    >
      <Icon name={icon} size={19} color={tint ?? colors.muted} />
    </Pressable>
  )
}

export function TurnBubble({
  turn,
  pairLanguages,
  canSpeak,
  onReplay,
  onCorrectText,
  onCorrectLanguage,
}: {
  turn: Turn
  pairLanguages: LanguageCode[]
  canSpeak: boolean
  onReplay: () => void
  onCorrectText: (text: string) => void
  onCorrectLanguage: (code: LanguageCode) => void
}) {
  const [editing, setEditing] = useState(false)
  const [showing, setShowing] = useState(false)
  const [flipped, setFlipped] = useState(false)
  const [draft, setDraft] = useState(turn.original)
  const [copied, setCopied] = useState(false)
  const isA = turn.speaker === 'A'
  const accent = isA ? colors.a : colors.b
  const src = LANGUAGES[turn.sourceLanguage]
  const tgt = LANGUAGES[turn.targetLanguage]
  const finished = turn.status === 'done' || turn.status === 'error'
  // Languages the turn could be switched to. De-duplicated so a pair like
  // English/English yields no candidate (button disabled) instead of a no-op
  // "switch" to the same language.
  const candidates = Array.from(new Set(pairLanguages)).filter((c) => c !== turn.sourceLanguage)
  const canSwitch = finished && candidates.length > 0

  const switchLanguage = () => {
    if (candidates.length === 1) {
      onCorrectLanguage(candidates[0])
      return
    }
    Alert.alert('Spoken language', `Recognised as ${src.label}. Which language was it?`, [
      { text: 'Cancel', style: 'cancel' },
      ...candidates.map((c) => ({ text: LANGUAGES[c].label, onPress: () => onCorrectLanguage(c) })),
    ])
  }

  const copy = async () => {
    if (!turn.translation) return
    await Clipboard.setStringAsync(turn.translation)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const submitEdit = () => {
    setEditing(false)
    const text = draft.trim()
    if (text && text !== turn.original) onCorrectText(text)
  }

  const provisional = turn.provisional && !!turn.original
  const translating = turn.status === 'translating' && !!turn.translation

  return (
    <View style={[styles.wrap, isA ? styles.left : styles.right]} accessible={false}>
      <View style={[styles.bubble, { borderLeftColor: accent }]}>
        <View style={styles.header}>
          <Text style={[styles.speaker, { color: accent }]} numberOfLines={1}>
            Speaker {turn.speaker}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={canSwitch ? `Recognised as ${src.label}. Tap to change the spoken language` : `Recognised as ${src.label}`}
            onPress={switchLanguage}
            disabled={!canSwitch}
            hitSlop={{ top: 12, bottom: 12, left: 6, right: 6 }}
            style={styles.langTag}
          >
            <Text style={styles.langTagText} numberOfLines={1}>
              {src.label}
              {turn.detectedLanguage ? ' (auto)' : ''}
            </Text>
            {canSwitch ? <Icon name="swap-horizontal" size={13} color={colors.faint} /> : null}
          </Pressable>
        </View>

        {turn.status === 'listening' && !turn.original ? <Spinner label={turn.heard ? 'Hearing you. Pause when you are done' : 'Listening. Speak now'} /> : null}
        {provisional ? (
          <Text style={styles.draftLabel} accessibilityLabel="Provisional text, still listening">
            Still listening, text may change
          </Text>
        ) : null}
        {turn.original ? <Text style={[styles.original, provisional && styles.provisional]}>{turn.original}</Text> : null}

        {turn.status === 'recognizing' ? <Spinner label="Turning speech into text" /> : null}
        {turn.status === 'translating' && !turn.translation ? <Spinner label={`Translating to ${tgt.label}`} /> : null}
        {turn.translation ? (
          <Text style={[styles.translation, translating && styles.provisional]} selectable accessibilityLabel={`${tgt.label}: ${turn.translation}`}>
            {turn.translation}
          </Text>
        ) : null}
        {turn.status === 'error' ? <Text style={styles.error}>{turn.error}</Text> : null}
        {turn.note && finished ? (
          <Text style={styles.note} accessibilityRole="alert">
            {turn.note}
          </Text>
        ) : null}

        {finished ? (
          <View style={styles.footer}>
            <Text style={styles.lang} numberOfLines={1}>
              {tgt.label}
            </Text>
            <View style={styles.actions}>
              {turn.translation ? (
                canSpeak ? <ActionIcon icon="volume-high-outline" label="Read translation aloud" onPress={onReplay} /> : null
              ) : null}
              <ActionIcon
                icon="create-outline"
                label="Correct recognised text"
                onPress={() => {
                  setDraft(turn.original)
                  setEditing(true)
                }}
              />
              {turn.translation ? (
                <ActionIcon icon={copied ? 'checkmark' : 'copy-outline'} label={copied ? 'Copied' : 'Copy translation'} onPress={() => void copy()} tint={copied ? colors.ok : undefined} />
              ) : null}
              {turn.translation ? <ActionIcon icon="expand-outline" label="Show translation full screen" onPress={() => setShowing(true)} /> : null}
            </View>
          </View>
        ) : null}
      </View>

      <Modal visible={showing} animationType="fade" onRequestClose={() => setShowing(false)} statusBarTranslucent>
        <View style={styles.showRoot}>
          <View style={[styles.showBody, flipped && styles.flipped]}>
            <Text style={styles.showLang}>{tgt.label}</Text>
            <Text style={styles.showText} adjustsFontSizeToFit minimumFontScale={0.4} numberOfLines={12} selectable>
              {turn.translation}
            </Text>
          </View>
          <View style={styles.showBar}>
            <Button kind="ghost" icon="sync-outline" title={flipped ? 'Turn back' : 'Turn around'} onPress={() => setFlipped((f) => !f)} style={{ flex: 1 }} />
            <Button kind="primary" icon="close" title="Close" onPress={() => setShowing(false)} style={{ flex: 1 }} />
          </View>
        </View>
      </Modal>

      <Modal visible={editing} transparent animationType="fade" onRequestClose={() => setEditing(false)}>
        <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle} accessibilityRole="header" numberOfLines={2}>
              Correct what was said ({src.label})
            </Text>
            <TextInput
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              multiline
              autoFocus
              placeholder="Type the corrected sentence"
              placeholderTextColor={colors.faint}
              accessibilityLabel="Corrected sentence"
              keyboardAppearance="dark"
            />
            <View style={styles.sheetActions}>
              <Button kind="ghost" title="Cancel" onPress={() => setEditing(false)} />
              <Button kind="primary" title="Re-translate" icon="refresh" onPress={submitEdit} disabled={!draft.trim()} />
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  )
}

const styles = StyleSheet.create({
  showRoot: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 20, paddingTop: 48, paddingBottom: 24 },
  showBody: { flex: 1, justifyContent: 'center', gap: 12 },
  flipped: { transform: [{ rotate: '180deg' }] },
  showLang: { color: colors.faint, fontSize: 14, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
  showText: { color: colors.text, fontSize: 40, lineHeight: 52, fontWeight: '700' },
  showBar: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  wrap: { marginBottom: 10, maxWidth: '92%' },
  left: { alignSelf: 'flex-start' },
  right: { alignSelf: 'flex-end' },
  bubble: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderLeftWidth: 3,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 4, gap: 10 },
  speaker: { fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4 },
  langTag: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1, minHeight: 20 },
  langTagText: { color: colors.faint, fontSize: 12, flexShrink: 1 },
  draftLabel: { color: colors.warn, fontSize: 11, fontWeight: '600', marginBottom: 2 },
  original: { color: colors.muted, fontSize: 15, lineHeight: 21, marginBottom: 4 },
  provisional: { fontStyle: 'italic', opacity: 0.85 },
  translation: { color: colors.text, fontSize: 19, fontWeight: '600', lineHeight: 27 },
  lang: { color: colors.faint, fontSize: 11, flexShrink: 1 },
  error: { color: colors.danger, fontSize: 13, marginTop: 4 },
  note: { color: colors.warn, fontSize: 12, lineHeight: 17, marginTop: 6 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, gap: 8 },
  actions: { flexDirection: 'row', marginRight: -10 },
  action: { minWidth: TOUCH, minHeight: TOUCH, alignItems: 'center', justifyContent: 'center' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 20 },
  sheet: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: 16 },
  sheetTitle: { color: colors.text, fontWeight: '700', fontSize: 15, marginBottom: 10 },
  sheetActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 12 },
  input: {
    minHeight: 90,
    maxHeight: 200,
    color: colors.text,
    backgroundColor: colors.surface2,
    borderRadius: radius.md,
    padding: 10,
    fontSize: 16,
    textAlignVertical: 'top',
  },
})
