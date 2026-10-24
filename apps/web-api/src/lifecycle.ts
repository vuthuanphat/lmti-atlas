interface LocalApiLifetime {
  close(): Promise<void>;
  isIdle(): boolean;
}

/** The listener retains its signal handlers until accepted work has closed. */
export async function startApiLifecycle(api: LocalApiLifetime, initialize: () => Promise<void>, options: {operatorControlled?: boolean} = {}): Promise<() => Promise<void>> {
  let closing: Promise<void> | undefined;
  let idle: ReturnType<typeof setInterval> | undefined;
  const shutdown = () => {
    if (closing) return closing;
    clearInterval(idle);
    // Retain the close promise: an accepted write must finish before shutdown completes.
    closing = Promise.resolve().then(() => api.close()).finally(() => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    });
    return closing;
  };
  const onSignal = () => {
    void shutdown().catch(() => {
      process.stderr.write('Local API could not close cleanly.\n');
      process.exitCode = 1;
    });
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    await initialize();
    // A signal may have completed shutdown while initialization awaited the
    // OS browser opener. Never advertise a listener that has already closed.
    if (closing) {
      await closing;
      throw new Error('Local API startup was interrupted.');
    }
    // An explicitly attached local console owns this lifetime. Authentication
    // still expires normally; only that console can ask for a fresh launch.
    if (!options.operatorControlled) {
      idle = setInterval(() => { if (api.isIdle()) onSignal(); }, 30000);
      idle.unref();
    }
    return shutdown;
  } catch (error) {
    await shutdown();
    throw error;
  }
}
