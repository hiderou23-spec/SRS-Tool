/**
 * Finding new versions of the app. A home-screen app on iPhone is usually
 * resumed from memory rather than reloaded, so the browser's own check (on
 * page load) rarely runs: check again whenever the app comes to the front,
 * hourly while open, and on demand from Settings.
 */
let registration: ServiceWorkerRegistration | undefined;
let lastCheck = 0;
const MIN_GAP_MS = 60_000;

export function onRegistered(r: ServiceWorkerRegistration | undefined): void {
  registration = r;
  if (!r) return;
  const check = () => {
    if (Date.now() - lastCheck < MIN_GAP_MS) return;
    lastCheck = Date.now();
    void r.update().catch(() => {});
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
  setInterval(check, 60 * 60_000);
}

export type UpdateCheck = 'found' | 'latest' | 'offline' | 'unsupported';

/** Ask the server for a newer version now (Settings button). */
export async function checkForUpdate(): Promise<UpdateCheck> {
  const r = registration;
  if (!r) return 'unsupported';
  if (r.waiting) return 'found';
  try {
    lastCheck = Date.now();
    await r.update();
  } catch {
    return 'offline';
  }
  if (r.waiting) return 'found';
  const sw = r.installing;
  if (!sw) return 'latest';
  // A newer version is downloading: wait until it is ready (the banner then shows).
  return new Promise((resolve) => {
    sw.addEventListener('statechange', () => {
      if (sw.state === 'installed') resolve('found');
      else if (sw.state === 'redundant') resolve('latest');
    });
  });
}
