interface LocalApiLifetime {
  close(): Promise<void>;
  isIdle(): boolean;
}

/** The listener retains its signal handlers until accepted work has closed. */
export async function startApiLifecycle(api: LocalApiLifetime, initialize: () => Promise<void>): Promise<() => Promise<void>> {
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
    if (!closing) {
      idle = setInterval(() => { if (api.isIdle()) onSignal(); }, 30000);
      idle.unref();
    }
    return shutdown;
  } catch (error) {
    await shutdown();
    throw error;
  }
}
