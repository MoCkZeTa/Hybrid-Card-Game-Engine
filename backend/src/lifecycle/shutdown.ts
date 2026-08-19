/**
 * Graceful shutdown.
 *
 * A container orchestrator sends SIGTERM and then waits — typically 30 seconds —
 * before SIGKILL. What happens in that window decides whether a deploy is
 * invisible or whether four people watch their game freeze:
 *
 *  - **Stop reporting ready** so the load balancer routes new connections away
 *    while the existing ones are still being served.
 *  - **Close sockets with a real close code**, so clients reconnect at once
 *    instead of sitting on a dead socket until their heartbeat notices.
 *  - **Release match ownership**, so a surviving node can adopt those matches
 *    immediately rather than after the lease expires.
 *  - **Then** close Redis and Mongo, which the steps above still depend on.
 *
 * The whole sequence is bounded: if a step hangs, the process exits anyway
 * rather than waiting for SIGKILL, because a stuck shutdown looks identical to
 * a stuck server from the outside.
 */

export interface ShutdownStep {
  readonly name: string;
  run(): Promise<unknown>;
}

export interface ShutdownOptions {
  /** Runs first, before any step — typically flipping the readiness flag. */
  readonly drain?: () => Promise<void>;
  readonly steps: readonly ShutdownStep[];
  /** Pause between draining and closing, giving the balancer time to notice. Default 3s. */
  readonly drainDelayMs?: number;
  /** Hard cap on the whole sequence. Default 15s. */
  readonly timeoutMs?: number;
}

export function installShutdownHandlers(options: ShutdownOptions): void {
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      // A second Ctrl-C means "I meant it".
      console.warn(`\n[shutdown] ${signal} received again — exiting now`);
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`\n[shutdown] ${signal} received — draining`);

    const deadline = setTimeout(() => {
      console.error('[shutdown] timed out — forcing exit');
      process.exit(1);
    }, options.timeoutMs ?? 15_000);
    deadline.unref?.();

    try {
      await options.drain?.();
      const drainDelayMs = options.drainDelayMs ?? 3_000;
      if (drainDelayMs > 0) await sleep(drainDelayMs);

      for (const step of options.steps) {
        try {
          await step.run();
          console.log(`[shutdown] closed ${step.name}`);
        } catch (err) {
          // One component failing to close cleanly must not strand the others.
          console.error(`[shutdown] failed to close ${step.name}:`, err);
        }
      }
      console.log('[shutdown] done');
    } finally {
      clearTimeout(deadline);
      process.exit(0);
    }
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  // An unhandled rejection used to be survivable; since Node 15 it terminates
  // the process by default. Logging it here means the reason reaches the logs
  // before that happens, instead of an opaque exit code.
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] unhandled promise rejection:', reason);
  });

  process.on('uncaughtException', (err) => {
    console.error('[fatal] uncaught exception:', err);
    void shutdown('uncaughtException');
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
