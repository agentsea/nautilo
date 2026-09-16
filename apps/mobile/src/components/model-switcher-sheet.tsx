// D382 Batch 1a — bottom-sheet model picker. The composer's model chip opens
// this. Fetches eligible models from the active server on open, lists them
// (label + provider/subtitle), marks the selected one, and calls back with
// the model id on tap. Uses the shared BottomSheet primitive (mirrors
// server-switcher-sheet). Themed via useAppTheme.
import { Ionicons } from '@expo/vector-icons';
import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import type { AssistantModelSummary } from '@nautilo/api-client/browser';

import { BottomSheet } from '@/components/bottom-sheet';
import { filterModelCatalogue } from '@/features/models/model-catalogue-search';
import { getApiClient } from '@/lib/api';
import { useServers } from '@/providers/server-registry';
import { useAppTheme } from '@/providers/theme';
import type { AppTheme } from '@/theme/tokens';

interface Props {
  visible: boolean;
  onClose: () => void;
  selectedModelId: string | null;
  defaultModelLabel: string;
  onSelect: (modelId: string | null) => void;
}

export function ModelSwitcherSheet({
  visible,
  onClose,
  selectedModelId,
  defaultModelLabel,
  onSelect,
}: Props) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const { activeServer } = useServers();

  const [models, setModels] = useState<AssistantModelSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  // Fetch on open (and re-fetch if the active server changes while open).
  useEffect(() => {
    if (!visible || !activeServer) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const api = getApiClient(activeServer.serverUrl);
        const [list, retained] = await Promise.all([
          api.getModels(),
          selectedModelId
            ? api.resolveRetainedModels([selectedModelId])
            : Promise.resolve([]),
        ]);
        if (cancelled) return;
        const byId = new Map(list.map((model) => [model.id, model]));
        for (const model of retained) byId.set(model.id, model);
        setModels(Array.from(byId.values()));
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not load models.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, activeServer, selectedModelId]);

  useEffect(() => {
    if (!visible) setQuery('');
  }, [visible]);

  const visibleModels = useMemo(() => filterModelCatalogue(models, query), [models, query]);

  const handlePick = useCallback(
    (id: string | null) => {
      onSelect(id);
      onClose();
    },
    [onSelect, onClose],
  );

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      snapPoints={['75%']}
      scrollable
      backdrop>
      <View style={styles.header}>
        <View style={styles.headerTitleRow}>
          <Text style={styles.title}>Choose model</Text>
          <Pressable
            style={styles.closeButton}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close model picker">
            <Ionicons name="close" size={22} color={t.color.text.foreground} />
          </Pressable>
        </View>
        <Text style={styles.stateSub}>This conversation only · resets when the app restarts.</Text>
      </View>

      <View style={styles.searchBox}>
        <Ionicons name="search-outline" size={18} color={t.color.text.muted} />
        <BottomSheetTextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search models"
          placeholderTextColor={t.color.text.dim}
          style={styles.searchInput}
          accessibilityLabel="Search models"
          autoCorrect={false}
          returnKeyType="search"
        />
        {query ? (
          <Pressable
            onPress={() => setQuery('')}
            style={styles.clearButton}
            accessibilityRole="button"
            accessibilityLabel="Clear model search">
            <Ionicons name="close-circle" size={18} color={t.color.text.muted} />
          </Pressable>
        ) : null}
      </View>

      {loading ? (
        <View style={styles.stateWrap}>
          <ActivityIndicator color={t.color.brand.accent} />
        </View>
      ) : error ? (
        <View style={styles.stateWrap}>
          <Text style={styles.stateTitle}>Could not load models</Text>
          <Text style={styles.stateSub}>{error}</Text>
        </View>
      ) : models.length === 0 ? (
        <View style={styles.stateWrap}>
          <Text style={styles.stateTitle}>No models available</Text>
          <Text style={styles.stateSub}>
            Contact a server administrator to configure a model provider.
          </Text>
        </View>
      ) : visibleModels.length === 0 ? (
        <View style={styles.stateWrap}>
          <Text style={styles.stateTitle}>No matching models</Text>
          <Text style={styles.stateSub}>Try a model name or provider.</Text>
        </View>
      ) : (
        <>
          <Pressable
            style={[styles.row, selectedModelId === null && styles.rowActive]}
            onPress={() => handlePick(null)}
            accessibilityRole="radio"
            accessibilityState={{ selected: selectedModelId === null }}>
            <View style={styles.rowMeta}>
              <Text style={styles.rowName} numberOfLines={1}>Use default</Text>
              <Text style={styles.rowSub} numberOfLines={1}>{defaultModelLabel}</Text>
            </View>
            {selectedModelId === null ? (
              <Ionicons name="checkmark" size={18} color={t.color.brand.accent} />
            ) : null}
          </Pressable>
          {visibleModels.map((m) => {
            const selected = m.id === selectedModelId;
            const selectable = m.availability === undefined || m.availability === 'selectable';
            const subtitle = selectable
              ? (m.provider ?? m.id)
              : `Unavailable · ${m.unavailableReason ?? 'not runnable now'}`;
            return (
              <Pressable
                key={m.id}
                style={[styles.row, selected && styles.rowActive]}
                disabled={!selectable}
                onPress={() => handlePick(m.id)}
                accessibilityRole="radio"
                accessibilityState={{ selected, disabled: !selectable }}>
                <View style={styles.rowMeta}>
                  <Text style={styles.rowName} numberOfLines={1}>
                    {m.displayName}
                  </Text>
                  <Text style={styles.rowSub} numberOfLines={1}>
                    {subtitle}
                  </Text>
                </View>
                {selected ? (
                  <Ionicons name="checkmark" size={18} color={t.color.brand.accent} />
                ) : null}
              </Pressable>
            );
          })}
        </>
      )}
    </BottomSheet>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    header: { paddingVertical: t.spacing.sm, marginBottom: t.spacing.xs },
    headerTitleRow: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: t.spacing.md,
    },
    title: { color: t.color.text.foreground, ...t.typography.subheading },
    closeButton: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: t.radii.pill,
    },
    searchBox: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.sm,
      paddingHorizontal: t.spacing.md,
      marginBottom: t.spacing.sm,
      borderRadius: t.radii.md,
      backgroundColor: t.color.surface.element,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.color.border.default,
    },
    searchInput: {
      flex: 1,
      minHeight: 44,
      color: t.color.text.foreground,
      ...t.typography.body,
    },
    clearButton: {
      width: 36,
      height: 36,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stateWrap: {
      paddingVertical: t.spacing.xl,
      alignItems: 'center',
      justifyContent: 'center',
      gap: t.spacing.sm,
    },
    stateTitle: { color: t.color.text.foreground, ...t.typography.subheading },
    stateSub: { color: t.color.text.muted, textAlign: 'center', ...t.typography.body },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.md,
      paddingVertical: t.spacing.md,
      paddingHorizontal: t.spacing.sm,
      borderRadius: t.radii.sm,
    },
    rowActive: { backgroundColor: t.color.surface.subtle },
    rowMeta: { flex: 1, gap: t.spacing.xs },
    rowName: { color: t.color.text.foreground, ...t.typography.bodyStrong },
    rowSub: { color: t.color.text.dim, ...t.typography.caption },
  });
}
