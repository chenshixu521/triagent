/**
 * Fixture parser for Task 11 Worker isolation tests.
 *
 * The first non-empty line is parsed as output so partial evidence can flow.
 * The crash-trigger line (containing CRASH_TRIGGER_MARKER_T11_9f3c2a1b) causes
 * an unrecoverable Worker crash. Main must retain that raw line in durable JSONL
 * even if parsing never produces a structured AgentEvent.
 */

export const CRASH_TRIGGER_MARKER = 'CRASH_TRIGGER_MARKER_T11_9f3c2a1b';

let calls = 0;

/**
 * @param {string} line
 * @returns {null | { type: string, attemptId: string, text?: string }}
 */
export function parseEvent(line) {
  if (typeof line !== 'string' || line.length === 0) {
    return null;
  }
  calls += 1;
  // First call: pretend to parse output so evidence can be retained.
  if (calls === 1 && !line.includes(CRASH_TRIGGER_MARKER)) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && parsed.type === 'output') {
        return {
          type: 'output',
          attemptId: String(parsed.attemptId ?? 'unknown'),
          text: String(parsed.text ?? line),
        };
      }
    } catch {
      // fall through to crash
    }
  }
  // Crash-trigger (or subsequent) lines crash the Worker hard.
  // Use a throw that becomes an uncaught exception when not handled, and also
  // force the worker thread to exit so isolation is unambiguous.
  const error = new Error(
    `crashing-parser: intentional Worker parser crash (${CRASH_TRIGGER_MARKER})`,
  );
  // Schedule hard exit so even try/catch around parse cannot keep the worker.
  setImmediate(() => {
    // eslint-disable-next-line n/no-process-exit
    process.exit(97);
  });
  throw error;
}

export default parseEvent;
