import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { createLocalDatabase, migrateLocalDatabase, type LocalDatabase } from './local-database';
import { adoptSharedDatabase, databaseNameFor, openExpoExecutor } from './expo-executor';
import { useSession } from '../session';
import { createThemedStyles, useTheme } from '../theme';

/**
 * Opens the signed-in person's own database, migrates it, and hands it to the tree.
 *
 * A phone is shared (0025), so each person's work lives in a file of its own: B signing in
 * after A sees none of A's audits and pushes none of A's queue. A's file stays on the
 * phone, untouched, and is theirs again the moment they sign back in.
 *
 * It survives a signed-out moment: the local store is the source of truth while an audit
 * is in progress (§9.1), so a token expiring in a plant with no signal keeps the open
 * database open. Only a *different* person signing in switches it.
 */
const LocalDatabaseContext = createContext<LocalDatabase | null>(null);

export function LocalDatabaseProvider({ children }: { children: ReactNode }) {
  const styles = useStyles();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const { user } = useSession();
  const [owner, setOwner] = useState<string | null>(null);
  const [database, setDatabase] = useState<LocalDatabase | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Signed out keeps whoever was open; a new person replaces them.
  const wanted = user?.id ?? owner;

  useEffect(() => {
    if (!wanted || wanted === owner) return;
    let cancelled = false;
    let opened: Awaited<ReturnType<typeof openExpoExecutor>> | null = null;

    void (async () => {
      try {
        setDatabase(null);
        await adoptSharedDatabase(wanted);
        opened = await openExpoExecutor(databaseNameFor(wanted));
        await migrateLocalDatabase(opened);
        if (cancelled) return;
        // Nothing read for the previous person — from their file or the server — may be
        // shown to this one. Their screens are not mounted while this spinner is up.
        queryClient.clear();
        setOwner(wanted);
        setDatabase(createLocalDatabase(opened));
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : 'Could not open local storage');
        }
      }
    })();

    return () => {
      cancelled = true;
      void opened?.close().catch(() => undefined);
    };
    // `owner` is deliberately read, not depended on: it only ever follows `wanted`.
  }, [wanted, queryClient]);

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }

  // Signed in, and that person's file is still opening — never a frame of somebody else's.
  if (user && (owner !== user.id || !database)) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.color.ink} />
      </View>
    );
  }

  // Signed out with nothing open yet: the login screen needs no local store.
  return (
    <LocalDatabaseContext.Provider value={database}>{children}</LocalDatabaseContext.Provider>
  );
}

export function useLocalDatabase(): LocalDatabase {
  const database = useContext(LocalDatabaseContext);
  if (!database) {
    throw new Error('useLocalDatabase used before anybody signed in on this phone');
  }
  return database;
}

/** For what runs whether or not anybody is signed in: the sync provider. */
export function useOptionalLocalDatabase(): LocalDatabase | null {
  return useContext(LocalDatabaseContext);
}

const useStyles = createThemedStyles((theme) => ({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.color.board,
  },
  error: {
    color: theme.color.crit,
    fontFamily: theme.family.regular,
    textAlign: 'center',
    padding: theme.space.lg,
  },
}));
