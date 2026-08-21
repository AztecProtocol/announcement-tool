/**
 * Scheduled function: runs every minute. Its ONLY job is to trigger the
 * tick-background function and return immediately, staying well inside
 * Netlify's 30-second cap for scheduled functions.
 *
 * The actual tick work (building adapters, calling runTick, logging) lives in
 * tick-background.ts, which Netlify's legacy `-background` naming convention
 * routes to and runs for up to 15 minutes.
 *
 * https://docs.netlify.com/build/functions/scheduled-functions/
 */

interface ScheduledConfig {
  schedule: string;
}

export default async (): Promise<void> => {
  const base = process.env.URL ?? '';
  const res = await fetch(`${base}/.netlify/functions/tick-background`, {
    method: 'POST',
    headers: { 'x-tick-secret': process.env.TICK_SECRET ?? '' },
  });
  if (res.status !== 202) {
    console.error(`tick-scheduled: expected 202 from tick-background, got ${res.status}`);
  }
};

export const config: ScheduledConfig = {
  schedule: '* * * * *',
};
