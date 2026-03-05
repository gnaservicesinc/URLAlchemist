import { useEffect, useState } from 'react';

import { getDefaultState, loadStoredState, subscribeStoredState } from '../../shared/storage';
import type { StoredState } from '../../shared/types';

export function useStoredExtensionState() {
  const [state, setState] = useState<StoredState>(getDefaultState);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    void loadStoredState().then((snapshot) => {
      if (!cancelled) {
        setState(snapshot);
        setLoading(false);
      }
    });

    const unsubscribe = subscribeStoredState((snapshot) => {
      setState(snapshot);
      setLoading(false);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return {
    state,
    setState,
    loading,
  };
}
