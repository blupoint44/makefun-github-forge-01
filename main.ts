// main.ts — entrypoint and harness lifecycle.
//
// Trial mode (MAKEFUN_ENV_URL set): start the forge on an ephemeral port,
// register that port with the environment, then wait until the environment
// reports the run is done before shutting down. Standalone mode (no env
// URL): serve on PORT (default 8080) for local development and testing.

import { createApp } from './app.ts';

const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const envUrl = process.env.MAKEFUN_ENV_URL ?? '';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function registerWithRetry(baseUrl: string, port: number): Promise<void> {
  let delayMs = 250;
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.status === 200) return;
      if (response.status === 409) {
        // Another entry registered first; this run has nothing to serve.
        console.error('registration conflict: another entry is registered');
        process.exit(0);
      }
      if (response.status === 400 || response.status === 405) {
        console.error(`registration rejected with status ${response.status}`);
        process.exit(1);
      }
    } catch {
      // Environment not reachable yet — fall through to the retry delay.
    }
    if (Date.now() > deadline) {
      console.error('registration timed out');
      process.exit(1);
    }
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 2_000);
  }
}

async function waitForDone(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 870_000;
  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/done`);
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Transient polling failures are expected; keep waiting.
    }
    if (Date.now() > deadline) return;
    await sleep(250);
  }
}

async function main(): Promise<void> {
  const { server } = createApp(token);

  if (envUrl === '') {
    const port = Number.parseInt(process.env.PORT ?? '8080', 10);
    await new Promise<void>((resolve) => server.listen(port, '0.0.0.0', resolve));
    console.log(`skywe-forge listening on port ${port} (standalone mode)`);
    return;
  }

  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    console.error('could not determine the listening port');
    process.exit(1);
  }
  await registerWithRetry(envUrl.replace(/\/$/, ''), address.port);
  await waitForDone(envUrl.replace(/\/$/, ''));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

void main();
