import React, { useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { LANGUAGES, LANGUAGE_LIST, type LanguageCode } from '../languages'
import { Icon } from './components'
import { colors, radius, TOUCH } from './theme'

export function LanguagePicker({
  value,
  onChange,
  color,
  label,
}: {
  value: LanguageCode
  onChange: (c: LanguageCode) => void
  color: string
  label: string
}) {
  const [open, setOpen] = useState(false)
  const def = LANGUAGES[value]
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${def.label}. Change language`}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.trigger, { opacity: pressed ? 0.7 : 1 }]}
      >
        <View style={[styles.dot, { backgroundColor: color }]} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.label} numberOfLines={1}>
            {label}
          </Text>
          <Text style={styles.value} numberOfLines={1}>
            {def.label}
          </Text>
        </View>
        <Icon name="chevron-down" size={16} color={colors.faint} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)} accessibilityRole="button" accessibilityLabel="Close">
          {/* Stop taps inside the sheet from reaching the backdrop and closing it. */}
          <View style={styles.sheet} onStartShouldSetResponder={() => true}>
            <Text style={styles.sheetTitle} accessibilityRole="header">
              {label}
            </Text>
            <ScrollView keyboardShouldPersistTaps="handled">
              {LANGUAGE_LIST.map((l) => {
                const selected = l.code === value
                return (
                  <Pressable
                    key={l.code}
                    accessibilityRole="button"
                    accessibilityLabel={`${l.label}, ${l.nativeLabel}`}
                    accessibilityState={{ selected }}
                    onPress={() => {
                      onChange(l.code)
                      setOpen(false)
                    }}
                    style={({ pressed }) => [styles.item, pressed && { opacity: 0.6 }]}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.itemText} numberOfLines={1}>
                        {l.label}
                      </Text>
                      <Text style={styles.itemNative} numberOfLines={1}>
                        {l.nativeLabel}
                      </Text>
                    </View>
                    {selected ? <Icon name="checkmark" size={20} color={color} /> : null}
                  </Pressable>
                )
              })}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </>
  )
}

const styles = StyleSheet.create({
  trigger: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: TOUCH,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 8,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  label: { color: colors.faint, fontSize: 10, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.6 },
  value: { color: colors.text, fontSize: 14, fontWeight: '600', marginTop: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: 16,
    paddingBottom: 28,
    maxHeight: '70%',
  },
  sheetTitle: { color: colors.muted, fontSize: 12, fontWeight: '700', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.6 },
  item: { flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingVertical: 10, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  itemText: { color: colors.text, fontSize: 16, fontWeight: '600' },
  itemNative: { color: colors.muted, fontSize: 13 },
})
