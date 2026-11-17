# Determinism scope

House Band makes a scoped reproducibility guarantee:

> With the same validated score artifact—therefore the same `schemaVersion`,
> `kitVersion`, seed, register, and score data—and the same pinned render
> toolchain, the renderer produces the same PCM WAV bytes and SHA-256.

The M1 toolchain fixes the sample rate at 44,100 Hz, encodes stereo signed
16-bit PCM without dither, and pins `node-web-audio-api` 2.2.0. The golden hash
fixture was established on Node v25.9.0, macOS (`darwin`) arm64. The manifest
records the runtime Node version, platform, architecture, and audio engine.

Hash stability is not claimed across Node releases, operating systems, CPU
architectures, WebAudio engine changes, kit versions, schema versions, sample
rates, channel layouts, or encoder changes. Floating-point DSP and convolution
may differ across those boundaries even when the musical result is equivalent.
The golden test is intentionally expected to fail when one of those boundaries
changes; accepting a new hash requires an explicit kit/toolchain version update.

JSON whitespace and object-key order do not affect `artifactSha256` because the
artifact is hashed as canonical sorted-key JSON. They also do not enter the WAV
encoder. The manifest itself is not promised byte-stable across platforms because
it records platform-specific toolchain fields; its `output.sha256` is the custody
identity for the audio bytes.

Kit 1.4 doctrine execution remains inside this scope. `register.class`, event
`role`, and `sections[].execution` are validated score data; role-onset postures
are fixed, mutation clocks derive only from authored section/step coordinates,
and no new random source is introduced. Identical validated score + seed + pinned
1.4 toolchain therefore remains byte-identical.
