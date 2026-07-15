import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Text,
  render as inkRender,
  useApp,
  useWindowSize,
  type Instance as InkInstance,
} from 'ink';

import { GlobalModal } from './components/GlobalModal.js';
import { StatusBar } from './components/StatusBar.js';
import { useKeyboard } from './hooks/useKeyboard.js';
import { DiffScreen } from './screens/DiffScreen.js';
import { HealthScreen } from './screens/HealthScreen.js';
import { HistoryScreen } from './screens/HistoryScreen.js';
import { StartScreen } from './screens/StartScreen.js';
import { PlanApprovalScreen } from './screens/PlanApprovalScreen.js';
import { ProjectScreen } from './screens/ProjectScreen.js';
import { RecoveryScreen } from './screens/RecoveryScreen.js';
import { ReviewScreen } from './screens/ReviewScreen.js';
import { RunScreen } from './screens/RunScreen.js';
import { SettingsScreen } from './screens/SettingsScreen.js';
import {
  createTuiStore,
  type ApplicationControllerPort,
  type TuiSnapshot,
  type TuiStore,
} from './store.js';

export interface AppProps {
  readonly snapshot: TuiSnapshot;
  readonly store?: TuiStore;
  readonly controller?: ApplicationControllerPort;
  readonly onSnapshotChange?: (snapshot: TuiSnapshot) => void;
  /**
   * Invoked when exit becomes authorized (controller exit_gate.allowed edge).
   * Tests inject this; production also uses useApp().exit on the same edge.
   */
  readonly onAuthorizedExit?: () => void;
  /**
   * When true, skip useWindowSize mutation (tests inject columns/rows via
   * snapshot). Production composition leaves this false.
   */
  readonly disableWindowSizeSync?: boolean;
}

/**
 * Full-screen TriAgent shell. Screens only render immutable store snapshots and
 * dispatch typed intents through the store/controller port.
 */
export function App(props: AppProps): React.ReactElement {
  const store = useMemo(
    () =>
      props.store ??
      createTuiStore({
        initial: props.snapshot,
        controller: props.controller,
      }),
    // Store identity is fixed for the lifetime of the mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.store, props.controller],
  );

  const [snapshot, setSnapshot] = useState<TuiSnapshot>(() => store.getSnapshot());
  const prevExitAuthorized = useRef(false);
  const lastAppliedProp = useRef<TuiSnapshot | null>(null);
  const { exit } = useApp();
  const onAuthorizedExitRef = useRef(props.onAuthorizedExit);
  onAuthorizedExitRef.current = props.onAuthorizedExit;
  const onSnapshotChangeRef = useRef(props.onSnapshotChange);
  onSnapshotChangeRef.current = props.onSnapshotChange;

  const handleAuthorizedEdge = (next: TuiSnapshot): void => {
    if (next.exitAuthorized && !prevExitAuthorized.current) {
      prevExitAuthorized.current = true;
      onAuthorizedExitRef.current?.();
      // Ink unmount path — never process.exit. Defer so subscribers can observe.
      queueMicrotask(() => {
        try {
          exit();
        } catch {
          // ink-testing-library may not fully support exit(); tests use onAuthorizedExit.
        }
      });
    } else if (!next.exitAuthorized) {
      prevExitAuthorized.current = false;
    }
  };

  // Authoritative store subscription — render only from store state.
  useEffect(() => {
    const initial = store.getSnapshot();
    setSnapshot(initial);
    prevExitAuthorized.current = initial.exitAuthorized;
    return store.subscribe((next) => {
      setSnapshot(next);
      handleAuthorizedEdge(next);
      onSnapshotChangeRef.current?.(next);
    });
    // exit is stable enough for the edge handler via closure on each effect run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, exit]);

  // Parent domain snapshot → replace into the same store (preserve UI state).
  useEffect(() => {
    if (props.snapshot === store.getSnapshot()) return;
    if (props.snapshot === lastAppliedProp.current) return;
    lastAppliedProp.current = props.snapshot;
    const next = store.replaceSnapshot(props.snapshot, { preserveUiState: true });
    // replaceSnapshot already notifies subscribers; edge handled there.
    void next;
  }, [props.snapshot, store]);

  const windowSize = useWindowSize();

  useEffect(() => {
    if (props.disableWindowSizeSync) return;
    if (
      windowSize.columns > 0 &&
      windowSize.rows > 0 &&
      (windowSize.columns !== snapshot.columns ||
        windowSize.rows !== snapshot.rows)
    ) {
      if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') {
        return;
      }
      store.setWindowSize(windowSize.columns, windowSize.rows);
    }
  }, [
    windowSize.columns,
    windowSize.rows,
    snapshot.columns,
    snapshot.rows,
    props.disableWindowSizeSync,
    store,
  ]);

  useKeyboard({
    store,
    onSnapshotChange: (next) => {
      setSnapshot(next);
      onSnapshotChangeRef.current?.(next);
    },
  });

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <ScreenRouter snapshot={snapshot} />
      <GlobalModal snapshot={snapshot} />
    </Box>
  );
}

function ScreenRouter(props: {
  readonly snapshot: TuiSnapshot;
}): React.ReactElement {
  const { snapshot } = props;
  switch (snapshot.screen) {
    case 'health':
      return (
        <Box flexDirection="column">
          <HealthScreen snapshot={snapshot} />
          <StatusBar snapshot={snapshot} />
        </Box>
      );
    case 'project':
      return (
        <Box flexDirection="column">
          <ProjectScreen snapshot={snapshot} />
          <StatusBar snapshot={snapshot} />
        </Box>
      );
    case 'new_task':
      return <StartScreen snapshot={snapshot} />;
    case 'plan_approval':
      return (
        <Box flexDirection="column">
          <PlanApprovalScreen snapshot={snapshot} />
          <StatusBar snapshot={snapshot} />
        </Box>
      );
    case 'run':
      return <RunScreen snapshot={snapshot} />;
    case 'diff':
      return (
        <Box flexDirection="column">
          <DiffScreen snapshot={snapshot} />
          <StatusBar snapshot={snapshot} />
        </Box>
      );
    case 'review':
      return (
        <Box flexDirection="column">
          <ReviewScreen snapshot={snapshot} />
          <StatusBar snapshot={snapshot} />
        </Box>
      );
    case 'history':
      return (
        <Box flexDirection="column">
          <HistoryScreen snapshot={snapshot} />
          <StatusBar snapshot={snapshot} />
        </Box>
      );
    case 'recovery':
      return (
        <Box flexDirection="column">
          <RecoveryScreen snapshot={snapshot} />
          <StatusBar snapshot={snapshot} />
        </Box>
      );
    case 'settings':
      return (
        <Box flexDirection="column">
          <SettingsScreen snapshot={snapshot} />
          <StatusBar snapshot={snapshot} />
        </Box>
      );
    default: {
      const _exhaustive: never = snapshot.screen;
      return <Text>Unknown screen: {String(_exhaustive)}</Text>;
    }
  }
}

/**
 * Composition helper for CLI entry. Uses alternate screen buffer.
 * Exit is delegated to the controller gate; never process.exit here.
 */
export function renderTuiApp(options: {
  readonly snapshot: TuiSnapshot;
  readonly store?: TuiStore;
  readonly controller?: ApplicationControllerPort;
  readonly onSnapshotChange?: (snapshot: TuiSnapshot) => void;
}): InkInstance {
  return inkRender(
    <App
      snapshot={options.snapshot}
      store={options.store}
      controller={options.controller}
      onSnapshotChange={options.onSnapshotChange}
      disableWindowSizeSync={false}
    />,
    {
      alternateScreen: true,
      exitOnCtrlC: false,
    },
  );
}
