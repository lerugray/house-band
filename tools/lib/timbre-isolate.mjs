/**
 * Render one isolated hit or note through the real band (no scheduler, no
 * score) for measurement. Analysis only. Uses a low master gain so the band's
 * glue compressor stays out of the way and measured levels are linear.
 */
import { OfflineAudioContext } from 'node-web-audio-api';
import { createBand } from '../../src/kit/band.js';

export const ISOLATE_RATE = 44100;

export async function renderIsolated(schedule, { seconds = 1.5, timbre, seed = 7, gain = 0.2 } = {}) {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * ISOLATE_RATE), ISOLATE_RATE);
  const band = createBand({ ctx, seed, gain, timbre, nowFn: () => 0, strict: true });
  schedule(band.voices);
  const buffer = await ctx.startRendering();
  band.dispose();
  return buffer.getChannelData(0);
}
