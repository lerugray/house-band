// Minimal ES-module score fixture for loadScore() path coverage.

export default {
  schemaVersion: '1.0.0',
  kitVersion: {
    semver: '1.1.0',
    sha: 'b2709519f2faf8481de28e0a5e9912cd2e80ae9e290fdfca88915c0377aaf773',
  },
  seed: 1,
  tempo: 120,
  sampleRate: 44100,
  gain: 0.5,
  label: 'Module-load test fixture',
  register: { name: 'audit-module', briefRef: 'docs/REGISTER-KIT-DEMO.md' },
  tracks: {
    loop: {
      bpm: 120,
      len: 16,
      vol: 1,
      steps: [
        { i: 0, voice: 'lead', note: 'C4', dur: 0.4, opts: { vol: 0.07, r: 0.2 } },
        { i: 4, voice: 'lead', note: 'E4', dur: 0.4, opts: { vol: 0.07, r: 0.2 } },
      ],
    },
  },
  sections: [
    { track: 'loop', bars: 1 },
    { track: 'loop', bars: 1 },
  ],
};
