import React from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import Ionicons from '@expo/vector-icons/Ionicons'
import { colors, radius, TOUCH } from './theme'

export type IconName = React.ComponentProps<typeof Ionicons>['name']

export function Icon({ name, size = 18, color = colors.text }: { name: IconName; size?: number; color?: string }) {
  return <Ionicons name={name} size={size} color={color} />
}

export function Button({
  title,
  onPress,
  kind = 'default',
  disabled,
  style,
  small,
  icon,
  accessibilityLabel,
}: {
  title: string
  onPress: () => void
  kind?: 'default' | 'primary' | 'danger' | 'ghost'
  disabled?: boolean
  style?: StyleProp<ViewStyle>
  small?: boolean
  icon?: IconName
  /** Required when `title` is empty (icon-only button). */
  accessibilityLabel?: string
}) {
  const bg = kind === 'primary' ? colors.a : kind === 'danger' ? colors.danger : kind === 'ghost' ? 'transparent' : colors.surface2
  const fg = kind === 'primary' || kind === 'danger' ? colors.onAccent : colors.text
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: !!disabled }}
      onPress={onPress}
      disabled={disabled}
      // Small buttons are ~36 dp tall; hitSlop brings the touch target to >= 44 dp.
      hitSlop={small ? 5 : undefined}
      style={({ pressed }) => [
        styles.btn,
        small && styles.btnSmall,
        { backgroundColor: bg, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
        kind === 'ghost' && { borderWidth: 1, borderColor: colors.border },
        style,
      ]}
    >
      {icon ? <Icon name={icon} size={small ? 16 : 18} color={fg} /> : null}
      {title ? <Text style={[styles.btnText, small && styles.btnTextSmall, { color: fg }, icon ? { marginLeft: 6 } : null]}>{title}</Text> : null}
    </Pressable>
  )
}

/** Compact icon + caption button used in toolbars. */
export function ToolButton({
  icon,
  label,
  onPress,
  active,
  disabled,
  accessibilityLabel,
}: {
  icon: IconName
  label: string
  onPress: () => void
  active?: boolean
  disabled?: boolean
  accessibilityLabel?: string
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!disabled, selected: !!active }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.tool, { opacity: disabled ? 0.35 : pressed ? 0.6 : 1 }]}
    >
      <Icon name={icon} size={20} color={active ? colors.a : colors.muted} />
      <Text style={[styles.toolLabel, active && { color: colors.a }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  )
}

export type Tone = 'ok' | 'warn' | 'danger' | 'muted' | 'info'

export function toneColor(tone: Tone): string {
  return tone === 'ok' ? colors.ok : tone === 'warn' ? colors.warn : tone === 'danger' ? colors.danger : tone === 'info' ? colors.a : colors.muted
}

export function Pill({ text, tone = 'muted' }: { text: string; tone?: Tone }) {
  const c = toneColor(tone)
  return (
    <View style={[styles.pill, { borderColor: c }]}>
      <Text style={[styles.pillText, { color: c }]} numberOfLines={1}>
        {text}
      </Text>
    </View>
  )
}

/** One engine's state: icon, name and a short value, used in the Setup status block. */
export function StatusChip({ icon, label, value, tone }: { icon: IconName; label: string; value: string; tone: Tone }) {
  const c = toneColor(tone)
  return (
    <View style={styles.chip} accessibilityLabel={`${label}: ${value}`}>
      <Icon name={icon} size={18} color={c} />
      <View style={{ flex: 1 }}>
        <Text style={styles.chipLabel} numberOfLines={1}>
          {label}
        </Text>
        <Text style={[styles.chipValue, { color: c }]} numberOfLines={1}>
          {value}
        </Text>
      </View>
    </View>
  )
}

export function Card({ children, style, title, hint }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; title?: string; hint?: string }) {
  return (
    <View style={[styles.card, style]}>
      {title ? (
        <Text style={styles.cardTitle} accessibilityRole="header">
          {title}
        </Text>
      ) : null}
      {hint ? <Text style={styles.cardHint}>{hint}</Text> : null}
      {children}
    </View>
  )
}

export function Row({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.row, style]}>{children}</View>
}

export function Spinner({ label }: { label?: string }) {
  return (
    <View style={styles.row} accessibilityLabel={label} accessibilityRole="progressbar">
      <ActivityIndicator color={colors.a} size="small" />
      {label ? <Text style={[styles.muted, { marginLeft: 8 }]}>{label}</Text> : null}
    </View>
  )
}

export function ProgressBar({ fraction, color = colors.a }: { fraction: number; color?: string }) {
  const f = Math.max(0, Math.min(1, fraction || 0))
  return (
    <View style={styles.progressTrack} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(f * 100) }}>
      <View style={[styles.progressFill, { width: `${Math.round(f * 100)}%`, backgroundColor: color }]} />
    </View>
  )
}

export const styles = StyleSheet.create({
  btn: {
    flexDirection: 'row',
    paddingHorizontal: 14,
    paddingVertical: 10,
    minHeight: TOUCH,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnSmall: { paddingHorizontal: 10, paddingVertical: 7, minHeight: 36, borderRadius: radius.sm },
  btnText: { fontWeight: '600', fontSize: 15 },
  btnTextSmall: { fontSize: 13 },
  tool: { alignItems: 'center', justifyContent: 'center', paddingVertical: 6, paddingHorizontal: 4, minWidth: 56, minHeight: TOUCH, flex: 1 },
  toolLabel: { color: colors.muted, fontSize: 11, marginTop: 3 },
  pill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginRight: 6,
    marginBottom: 4,
    maxWidth: '100%',
  },
  pillText: { fontSize: 11, fontWeight: '600' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.surface2,
    borderRadius: radius.md,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexBasis: '48%',
    flexGrow: 1,
  },
  chipLabel: { color: colors.muted, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4 },
  chipValue: { fontSize: 13, fontWeight: '600', marginTop: 1 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: '700', marginBottom: 6 },
  cardHint: { color: colors.muted, fontSize: 13, lineHeight: 18, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  muted: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  text: { color: colors.text, fontSize: 15, lineHeight: 21 },
  title: { color: colors.text, fontSize: 20, fontWeight: '700' },
  h2: { color: colors.text, fontSize: 15, fontWeight: '700', marginBottom: 2 },
  progressTrack: {
    height: 6,
    backgroundColor: colors.surface2,
    borderRadius: 3,
    overflow: 'hidden',
    marginVertical: 8,
  },
  progressFill: { height: 6 },
})
