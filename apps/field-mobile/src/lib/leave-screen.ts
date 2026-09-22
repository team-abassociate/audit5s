import { InteractionManager } from 'react-native';

/**
 * Leaves a screen, then refreshes the query cache — in that order, and never in the same
 * frame.
 *
 * Doing it the other way round crashes a release build. `invalidateQueries` re-renders
 * every mounted screen that reads the key, and popping the current screen in the same tick
 * makes `react-native-screens` re-parent a view that the re-render is still holding:
 *
 *     java.lang.IllegalStateException: addViewAt: cannot insert view [3872] into
 *     parent [3880]: View already has a parent: [2948]
 *     Parent: ScreenContentWrapper  View: ReactViewGroup
 *
 * Fabric treats that as a soft exception, tears the React host down and restarts it, so
 * the app goes white with nothing in the log but the mount error. It is release-only
 * because it is a race: under Hermes bytecode the invalidation cascade and the pop land in
 * one frame, while a debug build is slow enough to separate them — which is exactly why
 * submitting a 50-question audit was fine on a dev build and blanked the release APK.
 *
 * `runAfterInteractions` waits for the navigation transition to commit before the refresh
 * runs. Nothing is lost by the delay: the work is already in SQLite before `onSuccess`, and
 * the screen being returned to re-reads it when the refresh lands.
 */
export function leaveScreen(navigate: () => void, refresh: () => void): void {
  navigate();
  InteractionManager.runAfterInteractions(refresh);
}
