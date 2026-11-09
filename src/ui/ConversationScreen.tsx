import React, { useCallback, useEffect, useRef } from 'react'
import { Alert, FlatList, KeyboardAvoidingView, Pressable, StyleSheet, Text, View } from 'react-native'
import type { Interpreter } from '../state/useInterpreter'
import type { Speaker as SpeakerId, Turn } from '../state/types'
import { Button, Icon, ToolButton } from './components'
import { Composer } from './Composer'
import { LanguagePicker } from './LanguagePicker'
import { StatusLine } from './StatusBanner'
import { TurnBubble } from './TurnBubble'
import { VoiceButton } from './VoiceButton'
import { colors, radius, TOUCH } from './theme'

/**
 * Hands-free fields the hook may or may not expose yet (another agent owns the
 * hook). Read through a loose type so the screen builds either way.
 */
type HandsFree = { toggleAuto?: () => void; autoActive?: boolean; fastLoopActive?: SpeakerId | null }

export function ConversationScreen({ it, onOpenSetup }: { it: Interpreter; onOpenSetup: () => void }) {
  const { settings, status, turns } = it
  const hf = it as unknown as HandsFree
  const autoActive = hf.autoActive === true
  const listRef = useRef<FlatList<Turn>>(null)

  const mtReady = status.translator.state === 'ready'
  const mtLoading = status.translator.state === 'loading'
  const asrReady = status.asr.state === 'ready'
  const voiceReady = mtReady && asrReady
  const pair = [settings.langA, settings.langB]
  const lastTurn = turns[turns.length - 1]

  // Keep the newest turn in view. `onContentSizeChange` covers growth while a
  // translation streams; the effect covers a new turn appended while the list
  // is already at its final size.
  const scrollToEnd = useCallback(() => {
    if (turns.length) listRef.current?.scrollToEnd({ animated: true })
  }, [turns.length])
  useEffect(() => {
    const t = setTimeout(scrollToEnd, 50)
    return () => clearTimeout(t)
  }, [scrollToEnd, lastTurn?.id, lastTurn?.status])

  const clear = () => {
    if (!turns.length) return
    Alert.alert('Clear conversation?', 'The current conversation is removed from memory.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: it.clearConversation },
    ])
  }

  const toggleHandsFree = () => {
    if (!hf.toggleAuto) return
    if (settings.fastMode && !autoActive) {
      // Fast mode (text-only, short pauses) and hands-free are exclusive.
      it.stopListening()
      it.updateSettings({ fastMode: false })
      // Let the settings update commit before the hook reads it.
      setTimeout(() => hf.toggleAuto?.(), 0)
      return
    }
    hf.toggleAuto()
  }




  const handsFreeAvailable = voiceReady && !!hf.toggleAuto

  return (
    <KeyboardAvoidingView style={styles.root} behavior="padding">
      <View style={styles.topBar}>
        <LanguagePicker label="Speaker A" value={settings.langA} color={colors.a} onChange={(c) => it.updateSettings({ langA: c })} />
        <Pressable accessibilityRole="button" accessibilityLabel="Swap languages" onPress={it.swapLanguages} style={({ pressed }) => [styles.swap, pressed && { opacity: 0.6 }]}>
          <Icon name="swap-horizontal" size={20} color={colors.muted} />
        </Pressable>
        <LanguagePicker label="Speaker B" value={settings.langB} color={colors.b} onChange={(c) => it.updateSettings({ langB: c })} />
      </View>
      <StatusLine it={it} onPress={onOpenSetup} />

      {status.micPermission === 'denied' ? (
        <View style={styles.notice} accessibilityRole="alert">
          <Icon name="mic-off-outline" size={16} color={colors.warn} />
          <Text style={styles.noticeText}>Microphone access denied. Allow it in system settings to use voice. Typing still works.</Text>
        </View>
      ) : null}

      <FlatList
        ref={listRef}
        data={turns}
        keyExtractor={(t) => t.id}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={scrollToEnd}
        renderItem={({ item }) => (
          <TurnBubble
            turn={item}
            pairLanguages={pair}
            canSpeak={!!it.voiceSupport?.[item.targetLanguage] && !it.muted}
            onReplay={() => void it.replay(item.id)}
            onCorrectText={(t) => it.correctText(item.id, t)}
            onCorrectLanguage={(c) => void it.correctLanguage(item.id, c)}
          />
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>{mtReady ? 'Type to translate' : mtLoading ? 'Loading the translation model' : 'Set up the translation model'}</Text>
            <Text style={styles.emptyText}>
              {mtReady
                ? 'Pick who is talking, then type. The translation appears while you type and is ready when you press send.'
                : mtLoading
                  ? 'This takes a few seconds after the app starts.'
                  : 'The translation model (about 1 GB) is downloaded once and stays on this phone.'}
            </Text>
            {mtReady ? <Text style={styles.emptyText}>{it.onlineAsr ? 'Translation runs on this phone. Voice input is sent to Groq.' : 'Everything runs on this phone. Nothing is uploaded.'}</Text> : null}
            {!mtReady && !mtLoading ? <Button title="Open Setup" kind="primary" icon="settings-outline" onPress={onOpenSetup} style={{ alignSelf: 'flex-start', marginTop: 8 }} /> : null}
          </View>
        }
      />

      {status.listening ? (
        <View style={styles.listeningWrap} accessibilityLiveRegion="polite">
          <Text style={styles.listeningText}>
            {autoActive ? 'Listening to both of you. Each pause is translated.' : 'Listening. Keep talking; each pause is translated. Tap stop when done.'}
          </Text>
          <View style={styles.levelWrap} accessibilityLabel="Microphone level">
            <View style={[styles.level, { width: `${Math.min(100, Math.round(status.level * 400))}%`, backgroundColor: status.listening === 'A' ? colors.a : colors.b }]} />
          </View>
        </View>
      ) : null}

      <Composer
        langA={settings.langA}
        langB={settings.langB}
        enabled={mtReady}
        loading={mtLoading}
        voiceAvailable={voiceReady && !autoActive}
        listening={status.listening}
        preview={it.preview}
        onPreview={it.previewDraft}
        onClearPreview={it.clearPreview}
        onSend={it.typeTurn}
        onMic={(sp) => it.toggleSpeaker(sp)}
      />

      <View style={styles.toolbar}>
        <ToolButton icon="trash-outline" label="Clear" accessibilityLabel="Clear conversation" onPress={clear} disabled={!turns.length} />
        <VoiceButton active={autoActive} disabled={!handsFreeAvailable} level={status.level} onPress={toggleHandsFree} />
        <ToolButton icon="settings-outline" label="Setup" onPress={onOpenSetup} />
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 8, gap: 6 },
  swap: { width: TOUCH, height: TOUCH, alignItems: 'center', justifyContent: 'center', marginHorizontal: -6 },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.surface2, marginHorizontal: 16, marginTop: 4, padding: 10, borderRadius: radius.md },
  noticeText: { color: colors.text, fontSize: 13, flex: 1, lineHeight: 18 },
  list: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16, flexGrow: 1 },
  empty: { flex: 1, justifyContent: 'center', paddingHorizontal: 8, gap: 10 },
  emptyTitle: { color: colors.text, fontSize: 22, fontWeight: '700' },
  emptyText: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  listeningWrap: { gap: 6, paddingTop: 4 },
  listeningText: { color: colors.muted, fontSize: 12, paddingHorizontal: 16 },
  levelWrap: { height: 3, backgroundColor: colors.surface2, marginHorizontal: 16, borderRadius: 2, overflow: 'hidden' },
  level: { height: 3 },
  toolbar: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', paddingHorizontal: 8, paddingTop: 2, paddingBottom: 4 },
})
