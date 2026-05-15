type SnapshotFlush = () => void | Promise<void>;

let snapshotFlush: SnapshotFlush | null = null;

export const registerSnapshotFlush = (fn: SnapshotFlush | null) => {
  snapshotFlush = fn;
  return () => {
    if (snapshotFlush === fn) {
      snapshotFlush = null;
    }
  };
};

export const flushPendingSnapshot = async () => {
  const fn = snapshotFlush;
  if (fn) {
    await fn();
  }
};
