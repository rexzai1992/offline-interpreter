import React, { useEffect, useState } from 'react'
import * as Device from 'expo-device'
import { Alert, Linking, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { checkGroqKey, GROQ_MODEL } from '../engine/GroqAsr'
import { Speaker } from '../engine/Speaker'
import { Translator } from '../engine/Translator'
import { LANGUAGE_LIST, LANGUAGES } from '../languages'
import { ASR_MODELS, HY_MT2_Q4_K_M, MALAY_WHISPER_SMALL_Q8, SENSEVOICE_MODEL, SENSEVOICE_TOKENS, SILERO_VAD, type ModelFile } from '../models/catalog'
import { ModelManager, type DownloadStatus } from '../models/ModelManager'
import { historySizeBytes } from '../state/history'
import type { Interpreter } from '../state/useInterpreter'
import { formatBytes } from '../util/format'
import { runAsrModelComparison, runAsrSelfTest, runMtSelfTest, runSenseVoiceComparison, type SelfTestLine } from '../engine/SelfTest'
import { Button, Card, Icon, Pill, ProgressBar, Row, StatusChip, styles as s, type Tone } from './components'
import { colors, TOUCH } from './theme'

function ModelRow({
  m,
  status,
  selected,
  onSelect,
  companions = [],
}: {
  m: ModelFile
  status: DownloadStatus
  selected?: boolean
  onSelect?: () => void
  /** Small files that belong to this model; downloaded first and deleted with it. */
  companions?: ModelFile[]
}) {
  const start = async () => {
    const blocker = ModelManager.preflight(m)
    if (blocker) {
      Alert.alert('Cannot download', blocker)
      return
    }
    Alert.alert(
      `Download ${m.label}?`,
      `${formatBytes(m.sizeBytes)} from ${new URL(m.url).host}, stored on this device. License: ${m.license}. Wi-Fi recommended.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Download',
          onPress: () =>
            void (async () => {
              for (const c of companions) if (!ModelManager.isReady(c)) await ModelManager.download(c)
              await ModelManager.download(m)
            })().catch(() => undefined),
        },
      ],
    )
  }
  const del = () =>
    Alert.alert(`Delete ${m.label}?`, 'The file is removed from this device. You can download it again later.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () =>
          void (async () => {
            await ModelManager.delete(m)
            for (const c of companions) await ModelManager.delete(c)
          })(),
      },
    ])
  const downloading = status.state === 'downloading' || status.state === 'paused'
  return (
    <View style={styles.modelRow}>
      <View style={styles.modelHead}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.h2} numberOfLines={1}>
            {m.label}
          </Text>
          <Text style={s.muted} numberOfLines={2}>
            {m.description}
          </Text>
        </View>
        {status.state === 'ready' ? <Icon name="checkmark-circle" size={20} color={colors.ok} /> : null}
      </View>
      <Row style={{ marginTop: 6 }}>
        <Pill text={formatBytes(m.sizeBytes)} />
        <Pill text={m.license} />
        {status.state === 'ready' ? <Pill text="Installed" tone="ok" /> : null}
        {selected ? <Pill text="In use" tone="info" /> : null}
        {status.state === 'verifying' ? <Pill text="Verifying" tone="warn" /> : null}
      </Row>
      {downloading ? (
        <>
          <ProgressBar fraction={status.total ? status.bytes / status.total : 0} />
          <Text style={s.muted} numberOfLines={1}>
            {status.state === 'paused' ? 'Paused. ' : ''}
            {formatBytes(status.bytes)} of {formatBytes(status.total)}
          </Text>
        </>
      ) : null}
      {status.state === 'error' ? <Text style={styles.err}>{status.message}</Text> : null}
      {!m.url && status.state === 'absent' ? <Text style={s.muted}>Not available for download yet. It can be copied onto the phone from a computer (see README).</Text> : null}
      <Row style={{ marginTop: 8, gap: 8 }}>
        {(status.state === 'absent' || status.state === 'error') && m.url ? <Button small kind="primary" icon="cloud-download-outline" title="Download" onPress={() => void start()} /> : null}
        {status.state === 'downloading' ? <Button small icon="pause" title="Pause" onPress={() => void ModelManager.pause(m)} /> : null}
        {status.state === 'paused' ? <Button small kind="primary" icon="play" title="Resume" onPress={() => void ModelManager.resume(m)} /> : null}
        {downloading ? <Button small kind="ghost" title="Cancel" accessibilityLabel={`Cancel download of ${m.label}`} onPress={() => ModelManager.cancel(m)} /> : null}
        {status.state === 'ready' && onSelect && !selected ? <Button small kind="ghost" title="Use this model" onPress={onSelect} /> : null}
        {status.state === 'ready' ? <Button small kind="ghost" icon="trash-outline" title="Delete" accessibilityLabel={`Delete ${m.label}`} onPress={del} /> : null}
      </Row>
    </View>
  )
}

/** Names and special words the recognisers tend to mishear; saved when editing ends. */
function NamesCard({ value, onSave }: { value: string; onSave: (names: string) => void }) {
  // The parent keys this card on the saved value, so the draft restarts from it after a save.
  const [draft, setDraft] = useState(value)
  const save = () => {
    if (draft !== value) onSave(draft)
  }
  return (
    <Card
      title="Names and special words"
      hint="People, places and products the app should spell correctly. One per line. Add = and a spelling to fix how it is written in the other language, for example Takeshi = タケシ. Stored only on this phone."
    >
      <TextInput
        style={[styles.keyInput, { minHeight: 96, paddingVertical: 10, textAlignVertical: 'top' }]}
        value={draft}
        onChangeText={setDraft}
        onBlur={save}
        onEndEditing={save}
        multiline
        autoCorrect={false}
        autoCapitalize="words"
        placeholder={'Ahmad bin Ismail\nTakeshi = タケシ\nKLCC'}
        placeholderTextColor={colors.faint}
        accessibilityLabel="Names and special words, one per line"
        keyboardAppearance="dark"
      />
      {draft !== value ? <Button small kind="primary" title="Save names" icon="checkmark" onPress={save} style={{ alignSelf: 'flex-start', marginTop: 8 }} /> : null}
    </Card>
  )
}

function SettingRow({ label, hint, value, onChange, disabled }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <View style={[styles.settingRow, disabled && { opacity: 0.5 }]}>
      <View style={{ flex: 1, minWidth: 0, paddingRight: 12 }}>
        <Text style={s.text}>{label}</Text>
        {hint ? <Text style={s.muted}>{hint}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        accessibilityLabel={label}
        trackColor={{ true: colors.a, false: colors.surface2 }}
        thumbColor={colors.text}
      />
    </View>
  )
}

/** Compact four-way engine status shown at the top of Setup. */
function EngineStatus({ it }: { it: Interpreter }) {
  const { status, settings, voiceSupport } = it
  const mt = status.translator
  const asr = status.asr
  const mtChip: { value: string; tone: Tone } =
    mt.state === 'ready'
      ? { value: 'Ready', tone: 'ok' }
      : mt.state === 'loading'
        ? { value: `Loading ${Math.round(mt.progress)}%`, tone: 'warn' }
        : mt.state === 'error'
          ? { value: 'Error', tone: 'danger' }
          : ModelManager.isReady(HY_MT2_Q4_K_M)
            ? { value: 'Not loaded', tone: 'warn' }
            : { value: 'Not installed', tone: 'warn' }
  const asrChip: { value: string; tone: Tone } =
    asr.state === 'ready'
      ? { value: asr.gpu ? 'Ready (GPU)' : 'Ready', tone: 'ok' }
      : asr.state === 'loading'
        ? { value: 'Loading', tone: 'warn' }
        : asr.state === 'error'
          ? { value: 'Error', tone: 'danger' }
          : ModelManager.isReady(it.asrModel) && ModelManager.isReady(SILERO_VAD)
            ? { value: 'Not loaded', tone: 'warn' }
            : { value: 'Not installed', tone: 'warn' }
  const vA = voiceSupport?.[settings.langA]
  const vB = voiceSupport?.[settings.langB]
  const ttsChip: { value: string; tone: Tone } = !voiceSupport
    ? { value: 'Checking', tone: 'muted' }
    : it.muted
      ? { value: 'Muted', tone: 'muted' }
      : !vA || !vB
        ? { value: `No ${!vA ? LANGUAGES[settings.langA].label : LANGUAGES[settings.langB].label} voice`, tone: 'danger' }
        : vA.offline === 'yes' && vB.offline === 'yes'
          ? { value: 'Ready, offline', tone: 'ok' }
          : { value: 'Ready, check offline', tone: 'warn' }
  return (
    <View style={styles.chips}>
      <StatusChip icon="language-outline" label="Translation" value={mtChip.value} tone={mtChip.tone} />
      <StatusChip icon="mic-outline" label="Speech in" value={asrChip.value} tone={asrChip.tone} />
      <StatusChip icon="volume-high-outline" label="Speech out" value={ttsChip.value} tone={ttsChip.tone} />
      {it.onlineAsr ? (
        <StatusChip icon="cloud-outline" label="Network" value="Voice via Groq" tone="warn" />
      ) : (
        <StatusChip icon="cloud-offline-outline" label="Network" value={status.offline ? 'Offline, on-device' : 'Online'} tone={status.offline ? 'ok' : 'warn'} />
      )}
    </View>
  )
}

export function SetupScreen({ it, onBack }: { it: Interpreter; onBack: () => void }) {
  const { settings, modelStatus, status } = it
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1500)
    return () => clearInterval(id)
  }, [])
  const st = (m: ModelFile) => modelStatus[m.id] ?? ModelManager.getStatus(m.id)
  const mem = Translator.memoryCheck()
  const free = ModelManager.availableDiskSpace()
  const support = it.voiceSupport

  const enginePill = (state: string, progress?: number) =>
    state === 'ready' ? (
      <Pill text="Loaded" tone="ok" />
    ) : state === 'loading' ? (
      <Pill text={progress != null ? `Loading ${Math.round(progress)}%` : 'Loading'} tone="warn" />
    ) : state === 'error' ? (
      <Pill text="Error" tone="danger" />
    ) : (
      <Pill text="Not loaded" />
    )

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Back to conversation" style={({ pressed }) => [styles.back, pressed && { opacity: 0.6 }]}>
          <Icon name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={s.title} accessibilityRole="header">
          Setup
        </Text>
      </View>

      <Card title="Status">
        <EngineStatus it={it} />
        {mem.message ? <Text style={[mem.blocked ? styles.err : styles.warn, { marginTop: 8 }]}>{mem.message}</Text> : null}
        {status.translator.state === 'error' ? <Text style={styles.err}>{status.translator.message}</Text> : null}
        {status.asr.state === 'error' ? <Text style={styles.err}>{status.asr.message}</Text> : null}
      </Card>

      <Card title="Device">
        <Text style={s.text} numberOfLines={1}>
          {[Device.manufacturer, Device.modelName ?? 'Unknown'].filter(Boolean).join(' ')}, {Platform.OS === 'ios' ? 'iOS' : 'Android'} {Device.osVersion ?? ''}
        </Text>
        <Text style={s.muted}>RAM {Device.totalMemory ? formatBytes(Device.totalMemory) : 'unknown'}</Text>
        <Text style={s.muted}>
          Free storage {Number.isFinite(free) ? formatBytes(free) : 'unknown'}, models {formatBytes(ModelManager.totalOnDisk())}
        </Text>
      </Card>

      <Card title="Translation model" hint="Hy-MT2 1.8B in llama.cpp. Runs on this phone; nothing is uploaded.">
        <ModelRow m={HY_MT2_Q4_K_M} status={st(HY_MT2_Q4_K_M)} />
        <Row style={{ marginTop: 8, gap: 8 }}>
          {enginePill(status.translator.state, status.translator.state === 'loading' ? status.translator.progress : undefined)}
          {status.translator.state === 'unloaded' && st(HY_MT2_Q4_K_M).state === 'ready' ? (
            <Button small title="Load" accessibilityLabel="Load translation model" onPress={() => void Translator.load().catch(() => undefined)} />
          ) : null}
          {status.translator.state === 'ready' ? <Button small kind="ghost" title="Unload" accessibilityLabel="Unload translation model" onPress={() => void Translator.unload()} /> : null}
        </Row>
      </Card>

      <VoiceEngineCard it={it} />

      <Card title="Speech recognition" hint="whisper.cpp, on-device. Larger models are more accurate but slower.">
        {ASR_MODELS.map((m) => (
          <ModelRow key={m.id} m={m} status={st(m)} selected={settings.asrModelId === m.id} onSelect={() => it.updateSettings({ asrModelId: m.id })} />
        ))}
        <ModelRow m={MALAY_WHISPER_SMALL_Q8} status={st(MALAY_WHISPER_SMALL_Q8)} />
        <ModelRow m={SILERO_VAD} status={st(SILERO_VAD)} />
        <ModelRow m={SENSEVOICE_MODEL} status={st(SENSEVOICE_MODEL)} companions={[SENSEVOICE_TOKENS]} />
        <Row style={{ marginTop: 8, gap: 8 }}>
          {enginePill(status.asr.state)}
          <Button small kind="ghost" icon="refresh" title="Reload" accessibilityLabel="Reload speech engines" onPress={() => void it.loadEngines()} />
        </Row>
      </Card>

      <Card
        title="Speech output"
        hint={
          Platform.OS === 'android'
            ? 'Uses the voices installed on this phone. For offline use, install voice data in the system Text-to-speech settings.'
            : 'Uses the voices installed on this phone. iOS voices are on-device; Apple ships no Filipino voice.'
        }
      >
        {LANGUAGE_LIST.map((l) => {
          const v = support?.[l.code]
          const tone: Tone = !support ? 'muted' : !v ? 'danger' : v.offline === 'yes' ? 'ok' : v.offline === 'no' ? 'danger' : 'warn'
          const text = !support ? 'checking' : !v ? 'no voice' : v.offline === 'yes' ? 'offline' : v.offline === 'no' ? 'network' : 'offline unconfirmed'
          const inUse = l.code === settings.langA || l.code === settings.langB
          return (
            <View key={l.code} style={styles.voiceRow}>
              <Text style={[s.text, { flex: 1, minWidth: 0 }, inUse && { fontWeight: '600' }]} numberOfLines={1}>
                {l.label}
              </Text>
              <Text style={[s.muted, { marginRight: 8, maxWidth: 80 }]} numberOfLines={1}>
                {v ? v.language : ''}
              </Text>
              <Pill text={text} tone={tone} />
            </View>
          )
        })}
        <Row style={{ marginTop: 8, gap: 8 }}>
          <Button small kind="ghost" icon="refresh" title="Re-check" accessibilityLabel="Re-check voices" onPress={() => void Speaker.refreshVoices()} />
          <Button small kind="ghost" icon="volume-high-outline" title="Test voices" onPress={() => void testVoices()} />
          {Platform.OS === 'android' ? (
            <Button
              small
              kind="ghost"
              icon="open-outline"
              title="Voice settings"
              accessibilityLabel="Open system text-to-speech settings"
              onPress={() => void Linking.sendIntent('com.android.settings.TTS_SETTINGS').catch(() => Linking.openSettings())}
            />
          ) : null}
        </Row>
      </Card>

      <NamesCard key={settings.names} value={settings.names} onSave={(names) => it.updateSettings({ names })} />

      <Card title="Conversation">
        <SettingRow label="Auto-detect spoken language" hint="Between the two selected languages. Always on for English, Japanese and Mandarin (free with SenseVoice); this switch adds it for Malay and Filipino, which makes them slower." value={settings.autoDetect} onChange={(v) => it.updateSettings({ autoDetect: v })} />
        <SettingRow label="Show text while speaking" hint="Provisional text; uses more CPU." value={settings.provisional} onChange={(v) => it.updateSettings({ provisional: v })} />
        <SettingRow label="End turn when the sentence sounds complete" hint="Finishes sooner on clear sentence ends." value={settings.semanticEndOfTurn} onChange={(v) => it.updateSettings({ semanticEndOfTurn: v })} />
        <SettingRow label="Fast mode" hint="Keep listening, translate at short pauses. Text only." value={settings.fastMode} onChange={(v) => it.updateSettings({ fastMode: v })} />
        <SettingRow label="Ping-pong turns" hint="After playback, listen for the other speaker." value={settings.autoPingPong} onChange={(v) => it.updateSettings({ autoPingPong: v })} />
        <SettingRow
          label="SenseVoice for Japanese, English and Mandarin"
          hint="Much faster than Whisper for these three languages when installed. Malay and Filipino always use Whisper."
          value={settings.senseVoice}
          onChange={(v) => it.updateSettings({ senseVoice: v })}
        />
        <SettingRow
          label="Fast model for English and Mandarin"
          hint="Uses Whisper base (about 1 s) for those languages when installed. Japanese, Malay and Filipino keep the selected model."
          value={settings.fastAsrForEnZh}
          onChange={(v) => it.updateSettings({ fastAsrForEnZh: v })}
        />
        <SettingRow label="Read translations aloud" hint="Off: results are shown as text only." value={!settings.muted} onChange={(v) => it.updateSettings({ muted: !v })} />
        <View style={styles.settingRow}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.text}>End of turn after silence</Text>
            <Text style={s.muted} accessibilityLiveRegion="polite">
              {settings.endSilenceMs} ms
            </Text>
          </View>
          <Row style={{ gap: 6 }}>
            <Button
              small
              kind="ghost"
              icon="remove"
              title=""
              accessibilityLabel="Shorter silence"
              style={styles.stepper}
              disabled={settings.endSilenceMs <= 400}
              onPress={() => it.updateSettings({ endSilenceMs: Math.max(400, settings.endSilenceMs - 100) })}
            />
            <Button
              small
              kind="ghost"
              icon="add"
              title=""
              accessibilityLabel="Longer silence"
              style={styles.stepper}
              disabled={settings.endSilenceMs >= 2000}
              onPress={() => it.updateSettings({ endSilenceMs: Math.min(2000, settings.endSilenceMs + 100) })}
            />
          </Row>
        </View>
      </Card>

      <Card
        title="Privacy"
        hint={
          it.onlineAsr
            ? 'Online voice is on: each recorded utterance is uploaded to Groq for transcription. Typed text and all translation stay on this phone. Recent turns stay in memory as context until you clear the conversation.'
            : 'Audio and text are processed in memory on this phone and discarded. Recent turns stay in memory as context until you clear the conversation.'
        }
      >
        <SettingRow label="Save conversations on this phone" hint="Off by default. Private app storage only." value={settings.saveHistory} onChange={(v) => it.updateSettings({ saveHistory: v })} />
        <Row style={{ gap: 8, marginTop: 4 }}>
          <Text style={s.muted}>Saved: {formatBytes(historySizeBytes())}</Text>
          <Button
            small
            kind="ghost"
            icon="trash-outline"
            title="Delete history"
            accessibilityLabel="Delete saved history"
            onPress={() =>
              Alert.alert('Delete saved history?', 'All saved conversations are removed from this device.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Delete', style: 'destructive', onPress: it.wipeHistory },
              ])
            }
          />
        </Row>
      </Card>

      {__DEV__ ? <DevSelfTest /> : null}

      <Card title="Storage">
        <Button
          small
          kind="danger"
          icon="trash-outline"
          title="Delete all downloaded models"
          style={{ alignSelf: 'flex-start' }}
          onPress={() =>
            Alert.alert('Delete all model files?', `${formatBytes(ModelManager.totalOnDisk())} will be freed. Translation and voice input stop working until you download again.`, [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Delete all',
                style: 'destructive',
                onPress: () => {
                  void Translator.unload()
                  ModelManager.deleteAll()
                },
              },
            ])
          }
        />
      </Card>
    </ScrollView>
  )
}

function VoiceEngineCard({ it }: { it: Interpreter }) {
  const provider = it.settings.asrProvider
  const [draft, setDraft] = useState('')
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState<{ tone: Tone; text: string } | null>(null)

  const save = async () => {
    const key = draft.trim()
    if (!key) return
    setChecking(true)
    setMessage(null)
    const err = await checkGroqKey(key)
    setChecking(false)
    if (err) {
      setMessage({ tone: 'danger', text: err })
      return
    }
    await it.setGroqKey(key)
    setDraft('')
    setMessage({ tone: 'ok', text: 'Key saved and working.' })
  }

  const choose = (p: 'local' | 'groq') => {
    if (p === provider) return
    if (p === 'groq') {
      Alert.alert(
        'Use online voice recognition?',
        'Each utterance you record is sent to Groq to be transcribed. Translation still runs on this phone. You need internet and your own Groq API key.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Use Groq', onPress: () => it.updateSettings({ asrProvider: 'groq' }) },
        ],
      )
      return
    }
    it.updateSettings({ asrProvider: 'local' })
  }

  // A render helper, not a component: a component declared inside render would remount every time.
  const option = (value: 'local' | 'groq', title: string, hint: string) => {
    const selected = provider === value
    return (
      <Pressable
        key={value}
        accessibilityRole="radio"
        accessibilityState={{ selected }}
        onPress={() => choose(value)}
        style={({ pressed }) => [styles.option, selected && styles.optionSelected, pressed && { opacity: 0.7 }]}
      >
        <Icon name={selected ? 'radio-button-on' : 'radio-button-off'} size={20} color={selected ? colors.a : colors.faint} />
        <View style={{ flex: 1 }}>
          <Text style={s.text}>{title}</Text>
          <Text style={s.muted}>{hint}</Text>
        </View>
      </Pressable>
    )
  }

  return (
    <Card title="Voice recognition engine" hint="Where speech is turned into text. Translation always runs on this phone.">
      <View accessibilityRole="radiogroup" style={{ gap: 8, marginTop: 8 }}>
        {option('local', 'On this phone', 'Offline and private. English, Japanese and Chinese in well under a second (SenseVoice). Malay and Filipino take about 3 s (Whisper).')}
        {option('groq', `Online: Groq (${GROQ_MODEL})`, 'About 1 s per sentence. Needs internet. Audio is sent to Groq.')}
      </View>
      {provider === 'groq' ? (
        <View style={{ marginTop: 12, gap: 8 }}>
          <Text style={s.muted}>{it.groqKeySet ? 'An API key is saved on this phone.' : 'Enter your Groq API key (console.groq.com). It is stored only on this phone.'}</Text>
          <TextInput
            style={styles.keyInput}
            value={draft}
            onChangeText={setDraft}
            placeholder={it.groqKeySet ? 'Replace saved key' : 'gsk_...'}
            placeholderTextColor={colors.faint}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            accessibilityLabel="Groq API key"
          />
          <Row style={{ gap: 8 }}>
            <Button small kind="primary" title={checking ? 'Checking' : 'Check and save key'} disabled={!draft.trim() || checking} onPress={() => void save()} />
            {it.groqKeySet ? (
              <Button
                small
                kind="ghost"
                icon="trash-outline"
                title="Remove key"
                onPress={() => {
                  void it.setGroqKey('')
                  setMessage(null)
                }}
              />
            ) : null}
          </Row>
          {message ? <Text style={{ color: message.tone === 'ok' ? colors.ok : colors.danger, fontSize: 13 }}>{message.text}</Text> : null}
          {!it.groqKeySet ? <Text style={styles.warn}>Online recognition stays off until a key is saved.</Text> : null}
        </View>
      ) : null}
    </Card>
  )
}

function DevSelfTest() {
  const [lines, setLines] = useState<SelfTestLine[]>([])
  const [busy, setBusy] = useState(false)
  const run = async (fn: (log: (l: SelfTestLine) => void) => Promise<void>) => {
    setBusy(true)
    setLines([])
    try {
      await fn((l) => setLines((ls) => [...ls, l]))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card title="Developer self-test" hint="Development builds only.">
      <Row style={{ gap: 8 }}>
        <Button small icon="mic-outline" title="ASR test files" disabled={busy} onPress={() => void run(runAsrSelfTest)} />
        <Button small icon="speedometer-outline" title="Compare speech models" disabled={busy} onPress={() => void run(runAsrModelComparison)} />
        <Button small icon="hardware-chip-outline" title="SenseVoice speed test" disabled={busy} onPress={() => void run(runSenseVoiceComparison)} />
        <Button small icon="language-outline" title="Translation samples" disabled={busy} onPress={() => void run(runMtSelfTest)} />
      </Row>
      {lines.map((l, i) => (
        <View key={i} style={{ marginTop: 8 }}>
          <Text style={s.muted} numberOfLines={1}>
            {l.name}, {(l.ms / 1000).toFixed(2)}s
          </Text>
          <Text style={s.text} selectable>
            {l.text}
          </Text>
        </View>
      ))}
    </Card>
  )
}

async function testVoices() {
  const support = await Speaker.refreshVoices()
  const samples: Record<string, string> = {
    en: 'Hello, this is the English voice.',
    ms: 'Helo, ini suara Bahasa Melayu.',
    ja: 'こんにちは、これは日本語の音声です。',
    'zh-Hans': '你好，这是中文语音。',
    'zh-Hant': '你好，這是中文語音。',
    tl: 'Kumusta, ito ang boses na Filipino.',
  }
  for (const l of LANGUAGE_LIST) {
    if (support[l.code]) await Speaker.speak(samples[l.code], l.code)
  }
}

const styles = StyleSheet.create({
  option: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border },
  optionSelected: { borderColor: colors.a, backgroundColor: colors.aDim },
  keyInput: { color: colors.text, backgroundColor: colors.surface2, borderRadius: 10, paddingHorizontal: 12, minHeight: TOUCH, fontSize: 15, borderWidth: 1, borderColor: colors.border },
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 48 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 2, marginBottom: 12 },
  back: { width: TOUCH, height: TOUCH, alignItems: 'center', justifyContent: 'center', marginLeft: -12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  modelRow: { paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border, marginTop: 6 },
  modelHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  err: { color: colors.danger, fontSize: 13, marginTop: 4 },
  warn: { color: colors.warn, fontSize: 13 },
  settingRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, minHeight: 52, borderTopWidth: 1, borderTopColor: colors.border },
  voiceRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  stepper: { width: TOUCH, minHeight: TOUCH, paddingHorizontal: 0 },
})
