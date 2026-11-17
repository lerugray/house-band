/**
 * The curated sample kits and sample-backed patches, as data: which hits of
 * Ray's library (Ray Weiss's own sample library (ray-samples), read-only; the drum kits are a
 * purchased collection, the two patch packs are from Ray's first-party library:
 * see `ownLabel` below) each pack carries, and how each kit lane or patch zone maps onto
 * them. tools/build-timbre-packs.mjs turns this into
 *   sample-packs/<packId>/            (via tools/build-pack.mjs)
 *   src/presets/kits/<kit>.mjs        (generated; pins the pack identity)
 *   src/presets/patches/sampled.mjs   (generated)
 *
 * Packs stay lean: only the hits a kit or patch uses, each trimmed to the
 * audible part (`maxSeconds`, with build-pack's tail fade).
 */

const KITS_ROOT = 'Essential WAV From Mars/Drums/02. Kits';
const COLLECTION = 'Essential WAV From Mars (Samples From Mars LLC), purchased commercial collection held in ray-samples';

const PROVENANCE = 'first-party operator library (purchased commercial sample collection, cleared for use at purchase)';
const LICENSE = 'Samples From Mars - Terms and Conditions (purchased collection; copy held in ray-samples)';

/** Drum hits are filed as kick/snare/hat; every other drum is a `sampler` asset with a declared, unpitched root. */
const DRUM_ROOT = 60;

const hit = (id, file, voice, maxSeconds, tags = []) => ({
  id, file, voice, maxSeconds, tags: ['drum-kit', ...tags],
});

export const DRUM_PACKS = [
  {
    packId: 'tv-kit-linndrum',
    displayName: 'Timbre Range kit: LinnDrum',
    sourceCollection: `${COLLECTION} / ${KITS_ROOT}/Lindrum From Mars/01. OG Clean Kit`,
    kit: {
      id: 'linndrum',
      title: 'LinnDrum (sampled)',
      character: 'the early-80s digital drum machine: tight gated kick, cracking snare, ticky hats, side-stick, congas, tambourine, cowbell and cabasa',
      lineage: 'ray-samples: Essential WAV From Mars / Drums / Kits / Lindrum From Mars / OG Clean Kit',
      assets: [
        hit('kick', `${KITS_ROOT}/Lindrum From Mars/01. OG Clean Kit/BD Lindrum Orig.wav`, 'kick', 0.5),
        hit('snare', `${KITS_ROOT}/Lindrum From Mars/01. OG Clean Kit/SD Lindrum Orig 17.wav`, 'snare', 0.5),
        hit('hat-closed', `${KITS_ROOT}/Lindrum From Mars/01. OG Clean Kit/CH Lindrum Orig Decay 06.wav`, 'hat', 0.3),
        hit('hat-open', `${KITS_ROOT}/Lindrum From Mars/01. OG Clean Kit/OH Lindrum Orig.wav`, 'sampler', 0.95),
        hit('tom-low', `${KITS_ROOT}/Lindrum From Mars/01. OG Clean Kit/Tom Lindrum Orig 09.wav`, 'sampler', 0.8),
        hit('tom-mid', `${KITS_ROOT}/Lindrum From Mars/01. OG Clean Kit/Tom Lindrum Orig 18.wav`, 'sampler', 0.55),
        hit('tom-high', `${KITS_ROOT}/Lindrum From Mars/01. OG Clean Kit/Tom Lindrum Orig 22.wav`, 'sampler', 0.45),
        hit('clap', `${KITS_ROOT}/Lindrum From Mars/01. OG Clean Kit/Clap Lindrum Orig.wav`, 'sampler', 0.4),
        hit('sidestick', `${KITS_ROOT}/Lindrum From Mars/01. OG Clean Kit/SS Lindrum Orig 11.wav`, 'sampler', 0.4),
        hit('ride', `${KITS_ROOT}/Lindrum From Mars/01. OG Clean Kit/Ride Lindrum Orig.wav`, 'sampler', 1.8),
        hit('crash', `${KITS_ROOT}/Lindrum From Mars/01. OG Clean Kit/Crash Lindrum Orig.wav`, 'sampler', 1.8),
        hit('tambourine', `${KITS_ROOT}/Lindrum From Mars/01. OG Clean Kit/Tamb Lindrum Orig.wav`, 'sampler', 0.3),
        hit('cabasa', `${KITS_ROOT}/Lindrum From Mars/01. OG Clean Kit/Cabasa Lindrum Orig.wav`, 'sampler', 0.2),
        hit('cowbell', `${KITS_ROOT}/Lindrum From Mars/01. OG Clean Kit/Cowbell Lindrum Orig.wav`, 'sampler', 0.3),
        hit('conga-high', `${KITS_ROOT}/Lindrum From Mars/01. OG Clean Kit/Conga Lindrum Orig 36 F#4.wav`, 'sampler', 0.3),
        hit('conga-low', `${KITS_ROOT}/Lindrum From Mars/01. OG Clean Kit/Conga Lindrum Orig 24 F#3.wav`, 'sampler', 0.45),
      ],
      lanes: {
        kick: 'kick', snare: 'snare', hat: { default: 'closed', closed: 'hat-closed', open: 'hat-open' },
        tomLow: 'tom-low', tomMid: 'tom-mid', tomHigh: 'tom-high', clap: 'clap', rim: 'sidestick', ride: 'ride', crash: 'crash',
        perc: { default: 'tambourine', tambourine: 'tambourine', cabasa: 'cabasa', cowbell: 'cowbell', 'conga-high': 'conga-high', 'conga-low': 'conga-low' },
      },
    },
  },
  {
    packId: 'tv-kit-cr78',
    displayName: 'Timbre Range kit: CR-78 rhythm box',
    sourceCollection: `${COLLECTION} / ${KITS_ROOT}/CR78 From Mars/01. Kit 1`,
    kit: {
      id: 'cr78',
      title: 'CR-78 rhythm box (sampled)',
      character: 'the 1978 preset rhythm box: thumping kick, papery snare, ticking hats, bongos and congas standing in for toms, wooden rim',
      lineage: 'ray-samples: Essential WAV From Mars / Drums / Kits / CR78 From Mars / Kit 1',
      assets: [
        hit('kick', `${KITS_ROOT}/CR78 From Mars/01. Kit 1/Kick CR78 12.wav`, 'kick', 0.3),
        hit('snare', `${KITS_ROOT}/CR78 From Mars/01. Kit 1/Snare CR78 13.wav`, 'snare', 0.4),
        hit('snare-b', `${KITS_ROOT}/CR78 From Mars/01. Kit 1/Snare CR78 14.wav`, 'snare', 0.25),
        hit('hat-closed', `${KITS_ROOT}/CR78 From Mars/01. Kit 1/CH CR78 03.wav`, 'hat', 0.25),
        hit('hat-closed-b', `${KITS_ROOT}/CR78 From Mars/01. Kit 1/CH CR78 05.wav`, 'hat', 0.25),
        hit('hat-open', `${KITS_ROOT}/CR78 From Mars/01. Kit 1/OH CR78 03.wav`, 'sampler', 0.6),
        hit('tom-low', `${KITS_ROOT}/CR78 From Mars/01. Kit 1/Conga CR78 05.wav`, 'sampler', 0.35),
        hit('tom-mid', `${KITS_ROOT}/CR78 From Mars/01. Kit 1/Bongo Lo CR78.wav`, 'sampler', 0.25),
        hit('tom-high', `${KITS_ROOT}/CR78 From Mars/01. Kit 1/Bongo Hi CR78.wav`, 'sampler', 0.25),
        hit('rim', `${KITS_ROOT}/CR78 From Mars/01. Kit 1/Rim CR78 02.wav`, 'sampler', 0.3),
        hit('ride', `${KITS_ROOT}/CR78 From Mars/01. Kit 1/OH CR78 05.wav`, 'sampler', 0.6),
        hit('perc-a', `${KITS_ROOT}/CR78 From Mars/01. Kit 1/Perc CR78 17.wav`, 'sampler', 0.25),
        hit('perc-b', `${KITS_ROOT}/CR78 From Mars/01. Kit 1/Perc CR78 27.wav`, 'sampler', 0.2),
        hit('conga-b', `${KITS_ROOT}/CR78 From Mars/01. Kit 1/Conga CR78 07.wav`, 'sampler', 0.3),
      ],
      lanes: {
        kick: 'kick', snare: ['snare', 'snare-b'], hat: { default: 'closed', closed: ['hat-closed', 'hat-closed-b'], open: 'hat-open' },
        tomLow: 'tom-low', tomMid: 'tom-mid', tomHigh: 'tom-high', rim: 'rim', ride: 'ride',
        perc: { default: 'perc-a', 'perc-a': 'perc-a', 'perc-b': 'perc-b', conga: 'conga-b' },
      },
    },
  },
  {
    packId: 'tv-kit-vinyl-indie',
    displayName: 'Timbre Range kit: Vinyl indie',
    sourceCollection: `${COLLECTION} / ${KITS_ROOT}/Vinyl Drums From Mars/01. Old Skool Indie Kit`,
    kit: {
      id: 'vinyl-indie',
      title: 'Vinyl indie (acoustic drums)',
      character: 'real drums lifted off vinyl: round knocking kick, rimmy snare, floor and rack toms, loose hats, a long ride bell',
      lineage: 'ray-samples: Essential WAV From Mars / Drums / Kits / Vinyl Drums From Mars / Old Skool Indie Kit',
      assets: [
        hit('kick', `${KITS_ROOT}/Vinyl Drums From Mars/01. Old Skool Indie Kit/BD Knock Mid Vinyl.wav`, 'kick', 0.45),
        hit('kick-b', `${KITS_ROOT}/Vinyl Drums From Mars/01. Old Skool Indie Kit/BD Vari Tape Vinyl 05.wav`, 'kick', 0.45),
        hit('snare', `${KITS_ROOT}/Vinyl Drums From Mars/01. Old Skool Indie Kit/SD Vari Tape Vinyl 08.wav`, 'snare', 0.3),
        hit('snare-b', `${KITS_ROOT}/Vinyl Drums From Mars/01. Old Skool Indie Kit/SD Degraded Vinyl 08.wav`, 'snare', 0.3),
        hit('hat-closed', `${KITS_ROOT}/Vinyl Drums From Mars/01. Old Skool Indie Kit/CH Clean Lite Vinyl 10.wav`, 'hat', 0.28),
        hit('hat-open', `${KITS_ROOT}/Vinyl Drums From Mars/01. Old Skool Indie Kit/OH Clean Vinyl 14.wav`, 'sampler', 0.9),
        hit('tom-low', `${KITS_ROOT}/Vinyl Drums From Mars/01. Old Skool Indie Kit/Tom Clean Flr Vinyl 08.wav`, 'sampler', 0.6),
        hit('tom-mid', `${KITS_ROOT}/Vinyl Drums From Mars/01. Old Skool Indie Kit/Tom Vari Tape Vinyl 02.wav`, 'sampler', 0.8),
        hit('clap', `${KITS_ROOT}/Vinyl Drums From Mars/01. Old Skool Indie Kit/Clap Clean Vinyl 05.wav`, 'sampler', 0.2),
        hit('rim', `${KITS_ROOT}/Vinyl Drums From Mars/01. Old Skool Indie Kit/Rim Thick Vinyl 02.wav`, 'sampler', 0.2),
        hit('ride', `${KITS_ROOT}/Vinyl Drums From Mars/01. Old Skool Indie Kit/Ride Lite Bell Vinyl 02.wav`, 'sampler', 2.4),
        hit('shaker', `${KITS_ROOT}/Vinyl Drums From Mars/01. Old Skool Indie Kit/Shaker Clean Soft Vinyl.wav`, 'sampler', 0.1),
        hit('tambourine', `${KITS_ROOT}/Vinyl Drums From Mars/01. Old Skool Indie Kit/Tamb Hard Vinyl 01.wav`, 'sampler', 0.4),
        hit('cowbell', `${KITS_ROOT}/Vinyl Drums From Mars/01. Old Skool Indie Kit/Cowbell Lo Vinyl.wav`, 'sampler', 0.2),
      ],
      lanes: {
        kick: ['kick', 'kick-b'], snare: ['snare', 'snare-b'], hat: { default: 'closed', closed: 'hat-closed', open: 'hat-open' },
        tomLow: 'tom-low', tomMid: 'tom-mid', tomHigh: { asset: 'tom-mid', tune: 5 }, clap: 'clap', rim: 'rim', ride: 'ride',
        perc: { default: 'shaker', shaker: 'shaker', tambourine: 'tambourine', cowbell: 'cowbell' },
      },
    },
  },
  {
    packId: 'tv-kit-found-wood',
    displayName: 'Timbre Range kit: Found wood and tin',
    sourceCollection: `${COLLECTION} / ${KITS_ROOT}/Found Sounds From Mars/01. Arthur Ashe Kit`,
    kit: {
      id: 'found-wood',
      title: 'Found wood and tin (found-sound kit)',
      character: 'a kit built from things: chopping boards and a metal clank alternating on the kick, a wooden snare with a water slap, pot and bin toms, a twig snap and a squelching melon for hats, a ruler twang, a silo slam for the crash',
      lineage: 'ray-samples: Essential WAV From Mars / Drums / Kits / Found Sounds From Mars / Arthur Ashe Kit',
      assets: [
        hit('kick', `${KITS_ROOT}/Found Sounds From Mars/01. Arthur Ashe Kit/Chopping Boards Kick.wav`, 'kick', 0.4),
        hit('kick-b', `${KITS_ROOT}/Found Sounds From Mars/01. Arthur Ashe Kit/Metal Kick Double Speed.wav`, 'kick', 0.25),
        hit('snare', `${KITS_ROOT}/Found Sounds From Mars/01. Arthur Ashe Kit/Wood Snare.wav`, 'snare', 0.55),
        hit('hat-closed', `${KITS_ROOT}/Found Sounds From Mars/01. Arthur Ashe Kit/TwigSnap2 Tube.wav`, 'hat', 0.3),
        hit('hat-open', `${KITS_ROOT}/Found Sounds From Mars/01. Arthur Ashe Kit/Squelch Melon.wav`, 'sampler', 0.72),
        hit('snare-b', `${KITS_ROOT}/Found Sounds From Mars/01. Arthur Ashe Kit/Water Slap 01.wav`, 'snare', 0.6),
        hit('tom-low', `${KITS_ROOT}/Found Sounds From Mars/01. Arthur Ashe Kit/Big Plastic Bin 02.wav`, 'sampler', 0.5),
        hit('tom-mid', `${KITS_ROOT}/Found Sounds From Mars/01. Arthur Ashe Kit/Tom Open Pot Wood 01.wav`, 'sampler', 0.6),
        hit('tom-high', `${KITS_ROOT}/Found Sounds From Mars/01. Arthur Ashe Kit/Wood Tom 02.wav`, 'sampler', 0.45),
        hit('clap', `${KITS_ROOT}/Found Sounds From Mars/01. Arthur Ashe Kit/Mouth Pop.wav`, 'sampler', 0.3),
        hit('rim', `${KITS_ROOT}/Found Sounds From Mars/01. Arthur Ashe Kit/Wood Rim Shot.wav`, 'sampler', 0.15),
        hit('ride', `${KITS_ROOT}/Found Sounds From Mars/01. Arthur Ashe Kit/Ruler Twang.wav`, 'sampler', 0.78),
        hit('crash', `${KITS_ROOT}/Found Sounds From Mars/01. Arthur Ashe Kit/Silo Impact Slam.wav`, 'sampler', 1.6),
        hit('twang', `${KITS_ROOT}/Found Sounds From Mars/01. Arthur Ashe Kit/Poison Dart Short.wav`, 'sampler', 0.56),
        hit('chop', `${KITS_ROOT}/Found Sounds From Mars/01. Arthur Ashe Kit/TreeChop HalfSpeed.wav`, 'sampler', 0.28),
      ],
      lanes: {
        kick: ['kick', 'kick-b'], snare: ['snare', 'snare-b'], hat: { default: 'closed', closed: 'hat-closed', open: 'hat-open' },
        tomLow: 'tom-low', tomMid: 'tom-mid', tomHigh: 'tom-high', clap: 'clap', rim: 'rim', ride: 'ride', crash: 'crash',
        perc: { default: 'chop', chop: 'chop', twang: 'twang' },
      },
    },
  },
  {
    packId: 'tv-kit-dystopian-tech',
    displayName: 'Timbre Range kit: Dystopian tech',
    sourceCollection: `${COLLECTION} / ${KITS_ROOT}/Vinyl Drum Machines From Mars/09. Dystopian Tech Kit`,
    kit: {
      id: 'dystopian-tech',
      title: 'Dystopian tech (modular and vintage machines)',
      character: 'long modular sub kick, dark 606 snare, dusty MR-10 hats, wobbling and broken toms, flanged clap, laser and guiro percussion',
      lineage: 'ray-samples: Essential WAV From Mars / Drums / Kits / Vinyl Drum Machines From Mars / Dystopian Tech Kit',
      assets: [
        hit('kick', `${KITS_ROOT}/Vinyl Drum Machines From Mars/09. Dystopian Tech Kit/BD Modular Sub Vinyl 01.wav`, 'kick', 1.1),
        hit('snare', `${KITS_ROOT}/Vinyl Drum Machines From Mars/09. Dystopian Tech Kit/SD 606 Dark Lo Vinyl 02.wav`, 'snare', 0.34),
        hit('snare-b', `${KITS_ROOT}/Vinyl Drum Machines From Mars/09. Dystopian Tech Kit/SD 808 Verb Vinyl 01.wav`, 'snare', 0.37),
        hit('hat-closed', `${KITS_ROOT}/Vinyl Drum Machines From Mars/09. Dystopian Tech Kit/HH MR10 Dust CH Vinyl.wav`, 'hat', 0.22),
        hit('hat-open', `${KITS_ROOT}/Vinyl Drum Machines From Mars/09. Dystopian Tech Kit/HH MR10 Dirt OH Vinyl.wav`, 'sampler', 0.95),
        hit('tom-low', `${KITS_ROOT}/Vinyl Drum Machines From Mars/09. Dystopian Tech Kit/Tom Modular Wobble Vinyl.wav`, 'sampler', 1.1),
        hit('tom-mid', `${KITS_ROOT}/Vinyl Drum Machines From Mars/09. Dystopian Tech Kit/Tom Perkons Skin Big Vinyl 01.wav`, 'sampler', 0.78),
        hit('tom-high', `${KITS_ROOT}/Vinyl Drum Machines From Mars/09. Dystopian Tech Kit/Tom Machinedrum Broken Vinyl.wav`, 'sampler', 0.28),
        hit('clap', `${KITS_ROOT}/Vinyl Drum Machines From Mars/09. Dystopian Tech Kit/Clap 505 Flange Vinyl 01.wav`, 'sampler', 0.4),
        hit('rim', `${KITS_ROOT}/Vinyl Drum Machines From Mars/09. Dystopian Tech Kit/Duck Wendel Vari Vinyl 05.wav`, 'sampler', 0.17),
        hit('ride', `${KITS_ROOT}/Vinyl Drum Machines From Mars/09. Dystopian Tech Kit/HH 606 Sharp OH Gate Vinyl.wav`, 'sampler', 0.9),
        hit('laser', `${KITS_ROOT}/Vinyl Drum Machines From Mars/09. Dystopian Tech Kit/Laser Modular Tight Vinyl.wav`, 'sampler', 0.25),
        hit('guiro', `${KITS_ROOT}/Vinyl Drum Machines From Mars/09. Dystopian Tech Kit/Guiro CR78 Bend Vinyl 01.wav`, 'sampler', 0.93),
        hit('bell', `${KITS_ROOT}/Vinyl Drum Machines From Mars/09. Dystopian Tech Kit/Bell Modular Hard Vinyl.wav`, 'sampler', 0.23),
      ],
      lanes: {
        kick: 'kick', snare: ['snare', 'snare-b'], hat: { default: 'closed', closed: 'hat-closed', open: 'hat-open' },
        tomLow: 'tom-low', tomMid: 'tom-mid', tomHigh: 'tom-high', clap: 'clap', rim: 'rim', ride: 'ride',
        perc: { default: 'laser', laser: 'laser', guiro: 'guiro', bell: 'bell' },
      },
    },
  },
  {
    packId: 'tv-kit-synare-sds',
    displayName: 'Timbre Range kit: Synare and Simmons electro',
    sourceCollection: `${COLLECTION} / ${KITS_ROOT}/Synare From Mars/01. Classic 1 and ${KITS_ROOT}/SDS800 From Mars/01. Assorted Kit 1`,
    kit: {
      id: 'synare-sds',
      title: 'Synare and Simmons electro (sampled)',
      character: 'late-70s disco-tom electronics: pitch-diving Synare toms and zaps, a noisy Synare snare, boomy kick, Simmons hats',
      lineage: 'ray-samples: Essential WAV From Mars / Drums / Kits / Synare From Mars (Classic 1) and SDS800 From Mars (Assorted Kit 1)',
      assets: [
        hit('kick', `${KITS_ROOT}/Synare From Mars/01. Classic 1/BD Synare 29.wav`, 'kick', 0.4),
        hit('kick-b', `${KITS_ROOT}/Synare From Mars/01. Classic 1/BD Synare 01.wav`, 'kick', 0.4),
        hit('snare', `${KITS_ROOT}/Synare From Mars/01. Classic 1/Noise Various Synare 03.wav`, 'snare', 0.4),
        hit('snare-b', `${KITS_ROOT}/Synare From Mars/01. Classic 1/Noise Various Synare 07.wav`, 'snare', 0.3),
        hit('hat-closed', `${KITS_ROOT}/SDS800 From Mars/01. Assorted Kit 1/HH SDS800 12.wav`, 'hat', 0.25),
        hit('hat-open', `${KITS_ROOT}/SDS800 From Mars/01. Assorted Kit 1/HH SDS800 F 02.wav`, 'sampler', 1.3),
        hit('tom-low', `${KITS_ROOT}/Synare From Mars/01. Classic 1/Tom Synare C 10.wav`, 'sampler', 0.9),
        hit('tom-mid', `${KITS_ROOT}/Synare From Mars/01. Classic 1/Tom Synare C 06.wav`, 'sampler', 0.68),
        hit('tom-high', `${KITS_ROOT}/Synare From Mars/01. Classic 1/Tom Synare C 04.wav`, 'sampler', 0.54),
        hit('fm-tom', `${KITS_ROOT}/Synare From Mars/01. Classic 1/Tom FM Short Synare E 06.wav`, 'sampler', 1.2),
        hit('zap', `${KITS_ROOT}/Synare From Mars/01. Classic 1/Noise Down Synare B 07.wav`, 'sampler', 0.27),
        hit('sweep', `${KITS_ROOT}/Synare From Mars/01. Classic 1/Noise Synare Res 00 Sweep 01 A 10.wav`, 'sampler', 0.22),
        hit('simmons-tom', `${KITS_ROOT}/SDS800 From Mars/01. Assorted Kit 1/Tom SDS800 F 18.wav`, 'sampler', 0.9),
      ],
      lanes: {
        kick: ['kick', 'kick-b'], snare: ['snare', 'snare-b'], hat: { default: 'closed', closed: 'hat-closed', open: 'hat-open' },
        tomLow: 'tom-low', tomMid: 'tom-mid', tomHigh: 'tom-high',
        perc: { default: 'zap', zap: 'zap', sweep: 'sweep', 'fm-tom': 'fm-tom', 'simmons-tom': 'simmons-tom' },
      },
    },
  },
  {
    packId: 'tv-kit-tr707',
    displayName: 'Timbre Range kit: TR-707',
    sourceCollection: `${COLLECTION} / ${KITS_ROOT}/707 From Mars/01. Clean`,
    kit: {
      id: 'tr707',
      title: 'TR-707 (sampled)',
      character: 'the 1985 Roland digital drum machine: a short punchy PCM kick (a deeper alternate), snappy gated snare with a flam, crisp ticking hats, handclap, rimshot, cowbell and tambourine, pitched tom samples, hissy ride and crash',
      lineage: 'ray-samples: Essential WAV From Mars / Drums / Kits / 707 From Mars / Clean',
      assets: [
        hit('kick', `${KITS_ROOT}/707 From Mars/01. Clean/BD A 707.wav`, 'kick', 0.12),
        hit('kick-b', `${KITS_ROOT}/707 From Mars/01. Clean/BD B 707.wav`, 'kick', 0.15),
        hit('snare', `${KITS_ROOT}/707 From Mars/01. Clean/SD A 707.wav`, 'snare', 0.18),
        hit('snare-b', `${KITS_ROOT}/707 From Mars/01. Clean/SD B 707.wav`, 'snare', 0.17),
        hit('snare-flam', `${KITS_ROOT}/707 From Mars/01. Clean/SD B 707 Flam A.wav`, 'snare', 0.21),
        hit('hat-closed', `${KITS_ROOT}/707 From Mars/01. Clean/CH 707.wav`, 'hat', 0.18),
        hit('hat-open', `${KITS_ROOT}/707 From Mars/01. Clean/OH 707.wav`, 'sampler', 0.36),
        hit('tom-low', `${KITS_ROOT}/707 From Mars/01. Clean/Tom Lo 707.wav`, 'sampler', 0.72),
        hit('tom-mid', `${KITS_ROOT}/707 From Mars/01. Clean/Tom Mid 707.wav`, 'sampler', 0.72),
        hit('tom-high', `${KITS_ROOT}/707 From Mars/01. Clean/Tom Hi 707.wav`, 'sampler', 0.37),
        hit('clap', `${KITS_ROOT}/707 From Mars/01. Clean/Clap 707.wav`, 'sampler', 0.21),
        hit('rim', `${KITS_ROOT}/707 From Mars/01. Clean/Rimshot 707.wav`, 'sampler', 0.22),
        hit('ride', `${KITS_ROOT}/707 From Mars/01. Clean/Ride 707.wav`, 'sampler', 1.5),
        hit('crash', `${KITS_ROOT}/707 From Mars/01. Clean/Crash 707.wav`, 'sampler', 1.4),
        hit('cowbell', `${KITS_ROOT}/707 From Mars/01. Clean/Cowbell 707.wav`, 'sampler', 0.21),
        hit('tambourine', `${KITS_ROOT}/707 From Mars/01. Clean/Tambourine 707.wav`, 'sampler', 0.18),
      ],
      lanes: {
        kick: { default: 'a', a: 'kick', b: 'kick-b' },
        snare: { default: 'a', a: 'snare', b: 'snare-b', flam: 'snare-flam' },
        hat: { default: 'closed', closed: 'hat-closed', open: 'hat-open' },
        tomLow: 'tom-low', tomMid: 'tom-mid', tomHigh: 'tom-high', clap: 'clap', rim: 'rim', ride: 'ride', crash: 'crash',
        perc: { default: 'cowbell', cowbell: 'cowbell', tamb: 'tambourine' },
      },
    },
  },
];

// The two patch packs come from Ray's own first-party sample library, per the 2026-08-09 House Band
// founding (README, Timbre-Variety Law: "first-party, provenance-clean, paid-eligible"). The label
// names the source folders and that founding; it does not claim the files are hardware renders
// (Fix round 1, review S3-6: only that word was false).
const FOUNDING = 'per the 2026-08-09 House Band founding (README Timbre-Variety Law)';
const ownLabel = (folders) => `Ray Weiss\'s first-party sample library (ray-samples/${folders}), ${FOUNDING}`;
const OWN_LICENSE = 'first-party operator library';

const zone = (asset, lo, hi) => ({ asset, lo, hi });

/** Sample-backed instrument patches: pitched zones over multisampled renders. */
export const PATCH_PACKS = [
  {
    packId: 'tv-patch-microfreak',
    displayName: 'Timbre Range patches: MicroFreak renders',
    provenance: ownLabel('INSTRUMENTS/{MINT MF, SOR SAW, HUMBUCKER MF, SNES RHODES, SAWBELLS}'),
    licenseRef: OWN_LICENSE,
    attribution: 'MicroFreak-named multisamples from Ray Weiss\'s sample library (ray-samples / INSTRUMENTS: MINT MF, SOR SAW, HUMBUCKER MF, SNES RHODES, SAWBELLS); selected for the Timbre-Variety Law; first-party ' + FOUNDING + '.',
    sourceCollection: 'ray-samples / INSTRUMENTS (MicroFreak renders)',
    assets: [
      { id: 'mint-c3', file: 'INSTRUMENTS/MINT MF/MINT MF-048-100.wav', maxSeconds: 4.5, tags: ['pad', 'microfreak', 'swell'] },
      { id: 'mint-c4', file: 'INSTRUMENTS/MINT MF/MINT MF-060-100.wav', maxSeconds: 4.5, tags: ['pad', 'microfreak', 'swell'] },
      { id: 'mint-c5', file: 'INSTRUMENTS/MINT MF/MINT MF-072-100.wav', maxSeconds: 4.0, tags: ['pad', 'microfreak', 'swell'] },
      { id: 'sor-c3', file: 'INSTRUMENTS/SOR SAW/SOR SAW-048-100.wav', maxSeconds: 2.2, tags: ['lead', 'microfreak', 'saw'] },
      { id: 'sor-c4', file: 'INSTRUMENTS/SOR SAW/SOR SAW-060-100.wav', maxSeconds: 2.2, tags: ['lead', 'microfreak', 'saw'] },
      { id: 'sor-c5', file: 'INSTRUMENTS/SOR SAW/SOR SAW-072-100.wav', maxSeconds: 2.0, tags: ['lead', 'microfreak', 'saw'] },
      { id: 'hbk-e2', file: 'INSTRUMENTS/HUMBUCKER MF/HUMBUCKER MF-040-100.wav', maxSeconds: 1.8, tags: ['pluck', 'guitar', 'microfreak', 'ray-pick-5'] },
      { id: 'hbk-e3', file: 'INSTRUMENTS/HUMBUCKER MF/HUMBUCKER MF-052-100.wav', maxSeconds: 1.8, tags: ['pluck', 'guitar', 'microfreak', 'ray-pick-5'] },
      { id: 'hbk-e4', file: 'INSTRUMENTS/HUMBUCKER MF/HUMBUCKER MF-064-100.wav', maxSeconds: 1.6, tags: ['pluck', 'guitar', 'microfreak', 'ray-pick-5'] },
      { id: 'hbk-e5', file: 'INSTRUMENTS/HUMBUCKER MF/HUMBUCKER MF-076-100.wav', maxSeconds: 1.4, tags: ['pluck', 'guitar', 'microfreak', 'ray-pick-5'] },
      { id: 'rhodes-c3', file: 'INSTRUMENTS/SNES RHODES/SNES RHODES-048-100.wav', maxSeconds: 1.4, tags: ['pluck', 'electric-piano', 'snes'] },
      { id: 'rhodes-c4', file: 'INSTRUMENTS/SNES RHODES/SNES RHODES-060-100.wav', maxSeconds: 1.2, tags: ['pluck', 'electric-piano', 'snes'] },
      { id: 'rhodes-c5', file: 'INSTRUMENTS/SNES RHODES/SNES RHODES-072-100.wav', maxSeconds: 1.0, tags: ['pluck', 'electric-piano', 'snes'] },
      { id: 'sawbell-d3', file: 'INSTRUMENTS/SAWBELLS/SAWBELLS-050-100.wav', maxSeconds: 2.4, tags: ['bell', 'microfreak', 'saw-bell'] },
      { id: 'sawbell-d4', file: 'INSTRUMENTS/SAWBELLS/SAWBELLS-062-100.wav', maxSeconds: 2.2, tags: ['bell', 'microfreak', 'saw-bell'] },
      { id: 'sawbell-a4', file: 'INSTRUMENTS/SAWBELLS/SAWBELLS-070-100.wav', maxSeconds: 2.0, tags: ['bell', 'microfreak', 'saw-bell'] },
    ],
    patches: [
      {
        id: 'mint-swell', class: 'pad', title: 'MicroFreak swell pad',
        character: 'a recorded MicroFreak patch that blooms over almost half a second into a bright, slowly dying pad',
        vol: 0.08, env: { a: 0.02, r: 1.0 }, verb: 0.22, ring: 1.5,
        zones: [zone('mint-c3', 0, 54), zone('mint-c4', 55, 66), zone('mint-c5', 67, 127)],
      },
      {
        id: 'sor-saw', class: 'lead', title: 'MicroFreak saw lead',
        character: 'a recorded stacked-saw MicroFreak lead with its own built-in movement',
        vol: 0.07, env: { a: 0.003, r: 0.16 }, verb: 0.12, ring: 0.1,
        zones: [zone('sor-c3', 0, 55), zone('sor-c4', 56, 67), zone('sor-c5', 68, 127)],
      },
      {
        id: 'humbucker-guitar', class: 'pluck', title: 'Humbucker guitar',
        character: 'Ray\'s pick: the MicroFreak patch that genuinely sounds like a guitar; plucked, warm, one note per key',
        vol: 0.06, env: { a: 0.002, r: 0.2 }, verb: 0.12, ring: 0.6,
        zones: [zone('hbk-e2', 0, 46), zone('hbk-e3', 47, 58), zone('hbk-e4', 59, 70), zone('hbk-e5', 71, 127)],
      },
      {
        id: 'snes-rhodes', class: 'pluck', title: 'SNES Rhodes',
        character: 'a dark, short chip electric piano rendered from an SNES-style engine',
        vol: 0.06, env: { a: 0.002, r: 0.15 }, verb: 0.14, ring: 0.3,
        zones: [zone('rhodes-c3', 0, 54), zone('rhodes-c4', 55, 66), zone('rhodes-c5', 67, 127)],
      },
      {
        id: 'sawbells', class: 'bell', title: 'Saw bells',
        character: 'a saw-bell hybrid: a struck, buzzing metallic bell with a long shimmering tail',
        vol: 0.06, env: { a: 0.002, r: 0.5 }, verb: 0.26, ring: 1.6,
        zones: [zone('sawbell-d3', 0, 55), zone('sawbell-d4', 56, 66), zone('sawbell-a4', 67, 127)],
      },
    ],
  },
  {
    packId: 'tv-patch-ms20',
    displayName: 'Timbre Range patches: MS-20 renders',
    provenance: ownLabel('Homebrew MS 20'),
    licenseRef: OWN_LICENSE,
    attribution: 'MS-20-named samples from Ray Weiss\'s sample library (ray-samples / Homebrew MS 20); Ray pick #1, blanket-endorsed; first-party ' + FOUNDING + '.',
    sourceCollection: 'ray-samples / Homebrew MS 20',
    assets: [
      { id: 'ms20-bass-c2', file: 'Homebrew MS 20/ms20-bass9.wav', rootNote: 36, maxSeconds: 1.8, tags: ['bass', 'ms20', 'plucked'] },
      { id: 'ms20-bass-lp', file: 'Homebrew MS 20/ms20lpbass.wav', rootNote: 36, maxSeconds: 2.2, tags: ['bass', 'ms20', 'filtered'] },
      { id: 'ms20-square-c4', file: 'Homebrew MS 20/ms20 clearysquare.wav', rootNote: 60, maxSeconds: 2.0, tags: ['lead', 'ms20', 'square'] },
      { id: 'ms20-bell-c3', file: 'Homebrew MS 20/ms20-bell.wav', rootNote: 48, maxSeconds: 1.8, tags: ['bell', 'ms20'] },
      { id: 'ms20-tinkle-c5', file: 'Homebrew MS 20/ms20 tinkle.wav', rootNote: 72, maxSeconds: 2.0, tags: ['bell', 'ms20', 'tinkle'] },
    ],
    patches: [
      {
        id: 'ms20-bass', class: 'bass', title: 'MS-20 bass',
        character: 'hardware MS-20 bass: a hollow plucked note and a dark filtered one, stretched across the low register',
        vol: 0.1, env: { a: 0.003, r: 0.12 }, verb: 0.04, ring: 0.2,
        zones: [zone('ms20-bass-c2', 0, 42), zone('ms20-bass-lp', 43, 127)],
      },
      {
        id: 'ms20-square', class: 'lead', title: 'MS-20 hollow square',
        character: 'a near-pure MS-20 square wave: hollow, clarinet-like, no vibrato',
        vol: 0.07, env: { a: 0.003, r: 0.15 }, verb: 0.12, ring: 0.1,
        zones: [zone('ms20-square-c4', 0, 127)],
      },
      {
        id: 'ms20-bell', class: 'bell', title: 'MS-20 bell and tinkle',
        character: 'MS-20 bell low down, its high tinkle above: round, slightly crude hardware bells',
        vol: 0.06, env: { a: 0.002, r: 0.4 }, verb: 0.22, ring: 1.4,
        zones: [zone('ms20-bell-c3', 0, 66), zone('ms20-tinkle-c5', 67, 127)],
      },
    ],
  },
];

export { DRUM_ROOT, PROVENANCE, LICENSE };
