import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { createLocalDatabase, migrateLocalDatabase, type LocalDatabase } from './local-database';
import { openExpoExecutor } from './expo-executor';
import { theme } from '../theme';

/**
 * Opens the device database once, migrates it, and hands it to the tree.
 *
 * It sits above the session provider's gate rather than inside it: the local store is the
 * source of truth while an audit is in progress (§9.1), so it must survive a signed-out
 * moment — a token expiring in a plant with no signal must not take the data with it.
 */
const LocalDatabaseContext = createContext<LocalDatabase | null>(null);

export function LocalDatabaseProvider({ children }: { children: ReactNode }) {
  const [database, setDatabase] = useState<LocalDatabase | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const executor = await openExpoExecutor();
        await migrateLocalDatabase(executor);
        if (!cancelled) setDatabase(createLocalDatabase(executor));
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : 'Could not open local storage');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <View style={centered}>
        <Text style={{ color: theme.color.danger, textAlign: 'center', padding: theme.space.lg }}>
          {error}
        </Text>
      </View>
    );
  }

  if (!database) {
    return (
      <View style={centered}>
        <ActivityIndicator color={theme.color.brand} />
      </View>
    );
  }

  return (
    <LocalDatabaseContext.Provider value={database}>{children}</LocalDatabaseContext.Provider>
  );
}

export function useLocalDatabase(): LocalDatabase {
  const database = useContext(LocalDatabaseContext);
  if (!database) {
    throw new Error('useLocalDatabase used outside LocalDatabaseProvider');
  }
  return database;
}

const centered = {
  flex: 1,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  backgroundColor: theme.color.background,
};
