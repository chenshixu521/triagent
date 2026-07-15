/**
 * Adversarial fixture: fill the stdout pipe buffer before reading stdin.
 * Proves ProcessHost must drain stdout concurrently with stdin delivery.
 *
 * Protocol:
 * 1) Write FILL_BYTES of 'X' to stdout (enough to fill a default Windows pipe).
 * 2) Only then read all of stdin until EOF.
 * 3) Echo a fixed marker + the exact stdin payload to stdout, then exit 0.
 *
 * Never prints argv/env secrets; prompt arrives only via stdin.
 */
const FILL_BYTES = Number.parseInt(process.env.FILL_BYTES ?? '262144', 10);
const PROMPT_MARKER = 'STDIN_PROMPT_RECEIVED:';

async function main() {
  // Fill stdout enough that a synchronous parent WriteFile(stdin) would block
  // forever if the parent is not already draining this pipe.
  const chunk = Buffer.alloc(Math.min(FILL_BYTES, 64 * 1024), 0x58); // 'X'
  let remaining = FILL_BYTES;
  while (remaining > 0) {
    const size = Math.min(chunk.length, remaining);
    const slice = size === chunk.length ? chunk : chunk.subarray(0, size);
    const ok = process.stdout.write(slice);
    remaining -= size;
    if (!ok) {
      await new Promise((resolve) => process.stdout.once('drain', resolve));
    }
  }

  // Now read stdin (prompt). Parent must be able to deliver this while we filled.
  const chunks = [];
  for await (const piece of process.stdin) {
    chunks.push(Buffer.isBuffer(piece) ? piece : Buffer.from(piece));
  }
  const prompt = Buffer.concat(chunks).toString('utf8');

  // Exact prompt echo — tests assert this without logging host-side secrets.
  process.stdout.write(`${PROMPT_MARKER}${prompt}\n`);
  process.stdout.write('FIXTURE_DONE\n');
}

main().catch((error) => {
  process.stderr.write(String(error instanceof Error ? error.stack : error));
  process.exit(1);
});
