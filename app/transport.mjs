/**
 * Transport state machine for playing a pre-rendered AudioBuffer.
 * Keeps DOM/WebAudio details out of the tests.
 */

export const STATE = Object.freeze({
  IDLE: 'idle',
  PLAYING: 'playing',
  PAUSED: 'paused',
});

export function createTransport(ctx, callbacks = {}) {
  if (!ctx || typeof ctx.createBufferSource !== 'function') {
    throw new Error('createTransport: needs an AudioContext-like object');
  }

  let state = STATE.IDLE;
  let loop = false;
  let buffer = null;
  let heldBuffer = null;
  let source = null;
  let startedAt = 0;
  let pausedAt = 0;
  let duration = 0;
  let raf = null;

  const notify = (key, ...args) => {
    if (typeof callbacks[key] === 'function') callbacks[key](...args);
  };

  const setState = (next) => {
    if (state === next) return;
    state = next;
    notify('onStateChange', state);
  };

  const clamp = (t) => Math.max(0, Math.min(t, duration));

  const hasRaf = typeof requestAnimationFrame !== 'undefined';
  const hasCancel = typeof cancelAnimationFrame !== 'undefined';

  const tick = () => {
    if (state !== STATE.PLAYING) return;
    notify('onPosition', clamp(ctx.currentTime - startedAt), duration);
    raf = hasRaf ? requestAnimationFrame(tick) : setTimeout(tick, 50);
  };

  const stopRaf = () => {
    if (raf) {
      if (hasCancel) cancelAnimationFrame(raf);
      else clearTimeout(raf);
      raf = null;
    }
  };

  const releaseSource = () => {
    if (source) {
      try { source.stop(); } catch (_) { /* ignore */ }
      try { source.disconnect(); } catch (_) { /* ignore */ }
      source = null;
    }
  };

  const createSource = (offset) => {
    releaseSource();
    const s = ctx.createBufferSource();
    s.buffer = buffer;
    s.loop = loop;
    s.connect(ctx.destination);
    s.onended = () => {
      if (!loop) {
        pausedAt = duration;
        setState(STATE.IDLE);
        stopRaf();
        notify('onPosition', duration, duration);
      }
    };
    s.start(0, clamp(offset));
    return s;
  };

  return {
    get state() { return state; },
    get loop() { return loop; },
    get duration() { return duration; },
    get position() { return clamp(state === STATE.PLAYING ? ctx.currentTime - startedAt : pausedAt); },

    setBuffer(newBuffer) {
      if (!newBuffer || typeof newBuffer.length !== 'number') throw new Error('setBuffer: needs an AudioBuffer');
      if (state === STATE.PLAYING) {
        releaseSource();
        stopRaf();
        setState(STATE.IDLE);
      }
      buffer = newBuffer;
      duration = newBuffer.duration;
      pausedAt = 0;
      notify('onPosition', 0, duration);
    },

    holdCurrent() {
      heldBuffer = buffer;
    },

    swapHeld() {
      if (!heldBuffer) return false;
      const wasPlaying = state === STATE.PLAYING;
      const pos = this.position;
      this.setBuffer(heldBuffer);
      if (wasPlaying) this.play(pos);
      return true;
    },

    setLoop(value) {
      loop = Boolean(value);
      if (source) source.loop = loop;
    },

    play(from = null) {
      if (!buffer) return false;
      const offset = from !== null ? from : pausedAt;
      startedAt = ctx.currentTime - clamp(offset);
      pausedAt = 0;
      source = createSource(offset);
      setState(STATE.PLAYING);
      tick();
      return true;
    },

    stop() {
      releaseSource();
      stopRaf();
      pausedAt = 0;
      setState(STATE.IDLE);
      notify('onPosition', 0, duration);
    },

    pause() {
      if (state !== STATE.PLAYING) return;
      pausedAt = clamp(ctx.currentTime - startedAt);
      releaseSource();
      stopRaf();
      setState(STATE.PAUSED);
      notify('onPosition', pausedAt, duration);
    },

    togglePlay() {
      if (state === STATE.PLAYING) this.pause();
      else this.play();
    },

    seek(seconds) {
      const target = clamp(seconds);
      if (state === STATE.PLAYING) {
        releaseSource();
        startedAt = ctx.currentTime - target;
        source = createSource(target);
      }
      pausedAt = target;
      notify('onPosition', target, duration);
    },
  };
}
