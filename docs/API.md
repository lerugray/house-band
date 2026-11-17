# House Band API Specification  -  Prompt-to-Song Generation Service

## Revision record

Revision 2 applies the accepted findings from the House Band API adversarial refute. The original draft remains unchanged as the draft record.

This specification defines a local, single-user API layer for House Band: a localhost service that turns prompts into House Band songs by orchestrating register resolution, LLM score composition, strict score validation, deterministic custody rendering, and artifact packaging.

The API does not redesign the House Band score spec, kit, renderer, M3 pack format, or M2 Audition Room. The validated score JSON artifact remains the musical boundary. The API produces artifacts that the existing Audition Room can load, tweak, accept, and hand off.

Non-goals: cloud deployment design, a general authentication system, multi-tenant behavior, implementation code, a DAW replacement, or changes to the score-schema contract.

Ground-truth contracts for this revision are [DETERMINISM.md](./DETERMINISM.md), [M3-PACK-FORMAT.md](./M3-PACK-FORMAT.md), [M2-INTERFACE.md](./M2-INTERFACE.md), [version.mjs](../src/version.mjs), and [spec.mjs](../src/spec.mjs).

---

## 1. API surface

### 1.1 Base and security assumptions

- The service runs on the operator's machine.
- Base path: /v1.
- Primary model: asynchronous persisted jobs.
- Optional synchronous waiting is allowed, but every operation still creates a job.
- Requests and responses are JSON except artifact downloads and the event stream.
- The unauthenticated profile is strictly loopback-only.

In the unauthenticated profile the service:

- binds only to an explicit loopback address, initially 127.0.0.1;
- refuses startup for a wildcard, LAN, public, or otherwise non-loopback bind;
- accepts only configured loopback Host values including the configured port;
- rejects a present Origin unless it is the service's exact same origin;
- sends no cross-origin access headers and rejects cross-origin preflight; and
- does not trust forwarded host or origin headers.

A non-loopback bind requires a separate, explicit authenticated deployment profile. That profile is outside this local-service specification; the service must not infer or silently enable it.

### 1.2 Core resource: Job

A generation, validation, or render operation has:

- jobId;
- type: prompt_to_song, render_score, or validate_score;
- state;
- createdAt and updatedAt;
- progress and currentStage;
- validationCandidateCount;
- transportCallCount;
- error, if failed;
- artifacts, if any; and
- provenanceSummary, once known.

Prompt-to-song states are:

1. queued
2. admitting
3. resolving_register
4. composing
5. validating
6. rendering
7. packaging
8. succeeded
9. failed
10. canceled

Admission includes exact schema, pack, compatibility, renderer-profile, and request-constraint resolution. Once admission succeeds, those resolutions are immutable for the job.

### 1.3 Endpoints

#### GET /v1/health

Returns:

- status: ok or degraded;
- apiVersion;
- validatorAvailable;
- custodyRendererAvailable;
- defaultModelLane;
- briefCommandAvailable;
- packRegistryAvailable; and
- custodyStoreAvailable.

#### GET /v1/capabilities

Returns:

- apiVersion;
- supportedScoreSchemaVersions;
- defaultScoreSchemaVersion, currently 1.1.0;
- compatibilityMatrix, using the exact rows defined in Section 6.3;
- custodyRenderProfiles;
- renderer capabilities, including stems and RPP;
- configured composition lanes and bounded attempt limits;
- register sources: supplied, command when configured (weiss accepted as an alias), and neutral; and
- exact installed pack identities or a link to /v1/packs.

#### GET /v1/packs

Returns validated local M3 pack snapshots. Each entry contains:

- format, exactly house-band-sample-pack;
- formatVersion, currently 1.0.0;
- packId;
- displayName;
- manifestSha256;
- contentSha256;
- installed;
- immutableSnapshotAvailable;
- schemaCompatibility;
- rendererCompatibility;
- assets, each with:
  - id, the exact M3 manifest asset id used as assetId in a score binding;
  - wavSha256;
  - pcmSha256;
  - allowedCanonicalLanes, currently a typed subset of kick, snare, and hat;
  - canonical file metadata; and
  - license or credit summary, if present.

Assets are M3 asset identities, not new House Band voice IDs. The canonical voice set remains the set declared by [spec.mjs](../src/spec.mjs).

#### POST /v1/songs

Creates a prompt-to-song job. Unknown fields are rejected. The JSON request has:

- prompt: required string, 1 to 32,768 UTF-8 bytes;
- titleHint: optional string, at most 500 characters;
- scoreSchemaVersion: optional exact supported version; default 1.1.0;
- register: optional object:
  - source: supplied, command, or neutral ("weiss" is accepted as an alias for "command");
  - brief: required non-empty string for supplied, forbidden otherwise;
  - notes: optional string;
  - allowNeutralFallback: optional boolean, default false, meaningful only for command;
- pack: optional object:
  - format: const house-band-sample-pack;
  - formatVersion: exact supported value;
  - packId: exact lowercase slug;
  - manifestSha256: exact lowercase SHA-256;
  - contentSha256: exact lowercase SHA-256;
  - policy: required or preferred;
  - assetAllowlist: optional array of exact asset IDs;
- canonicalVoiceAllowlist: optional array containing only canonical voice IDs;
- seed: optional unsigned 32-bit integer; generated once at admission if absent;
- duration: optional object governed by Section 2.1:
  - targetSeconds;
  - minSeconds;
  - maxSeconds;
  - targetBars;
  - loopable;
- sections: optional array of at most 1,024 objects, each containing:
  - name: required string matching the score track-name grammar;
  - bars: optional integer from 1 through 4,096; and
  - direction: optional string of at most 2,000 characters;
- composition: optional object:
  - modelLaneId;
  - maxValidationAttempts;
- render: optional object:
  - fullMix: const true, default true;
  - stems: boolean, default false;
  - rpp: boolean, default false;
- execution: optional object:
  - mode: async or sync_wait, default async;
  - waitTimeoutMs: positive integer allowed only for sync_wait.

Pack requests are exact identities only. Release versions, version ranges, and registry-path selection are not part of this API.

Schema selection is resolved and persisted before composition. Version 1.1.0 is the current default and is required for a pack-backed request. Version 1.0.0 is supported only as the legacy synthesis path; samplePack and sampleVoices are forbidden under it, as required by [version.mjs](../src/version.mjs) and [spec.mjs](../src/spec.mjs).

The full mix is mandatory for prompt-to-song jobs. If rpp is true and stems is omitted, stems defaults to true. Explicit rpp:true with stems:false is rejected. Explicit fullMix:false is rejected.

Responses:

- 202 Accepted for an asynchronous or still-running job;
- 200 OK when sync_wait completes before its timeout; or
- 202 Accepted when sync_wait times out while the job continues.

Every accepted response includes jobId, state, createdAt, and links to status, events, and artifacts when present.

#### GET /v1/jobs/{jobId}

Returns the authoritative persisted job record, including the counters that separately report provider transport calls and validation candidates.

#### GET /v1/jobs/{jobId}/events

Streams Server-Sent Events with Content-Type text/event-stream; charset=utf-8 and Cache-Control no-cache.

Each persisted event has:

- id: a per-job, monotonically increasing decimal integer;
- event: one of the job event types below; and
- data: one compact JSON object on a data line.

Events are emitted and replayed in ascending id order. A client resumes with the Last-Event-ID header or the after query parameter, but not both. The server replays every retained event with an id greater than the cursor, then follows live events. A missing cursor starts at the first retained event. If required history has expired, the server returns an EVENT_CURSOR_EXPIRED error before opening the stream; it never skips a gap silently.

Comment heartbeats may be sent at least every 15 seconds while idle and do not consume event IDs. After job_succeeded, job_failed, or job_canceled, the server sends that terminal event and closes the stream. Reconnecting after termination replays through the terminal event and closes again. The job record, not the stream, remains authoritative.

Event types:

- job_started;
- admission_completed;
- register_resolved;
- composition_transport_started;
- composition_transport_failed;
- composition_candidate_received;
- composition_attempt_failed_validation;
- composition_validated;
- render_started;
- stem_render_started;
- rpp_generated;
- artifact_written;
- job_succeeded;
- job_failed; and
- job_canceled.

#### POST /v1/jobs/{jobId}/cancel

Requests best-effort cancellation. A canceled operation cannot publish partial artifacts as accepted outputs.

#### GET /v1/jobs/{jobId}/artifacts

Lists accepted and explicitly non-accepted diagnostic artifacts. Each entry contains:

- artifactId;
- kind;
- filename;
- mediaType;
- sizeBytes;
- sha256;
- createdAt;
- acceptance: accepted, attempt, partial, or derivative; and
- canonicalSongIdentity: boolean.

Kinds include request, register, composition_request, composition_response, score, validation_report, manifest, provenance, wav_mix, wav_stem, rpp, pack_sidecar, derivative_recipe, and bundle.

#### GET /v1/jobs/{jobId}/artifacts/{artifactId}

Downloads one artifact.

The accepted bundle contains:

- accepted canonical score JSON;
- canonical full-mix WAV;
- manifest;
- provenance;
- validation report;
- exact register artifact at its logical briefRef;
- exact composition requests and raw responses;
- stems, if rendered;
- RPP, if generated; and
- for a sample-backed score, either the exact validated M3 sidecar or a durable reference to the immutable custody-store object defined in Section 2.6.

#### POST /v1/scores/validate

Validates a caller-supplied score using the same duplicate-aware parser, strict schema validator, and pack gates used by jobs.

Request:

- score: required JSON object;
- expectedSchemaVersion: optional exact version;
- exactPackIdentity: optional exact identity for a sample-backed score.

Response:

- valid;
- scoreSchemaVersion;
- errors and warnings;
- artifactSha256 when parseable and canonicalizable; and
- canonicalScore when valid.

Validation never mutates the caller's score. The canonicalScore response is a distinct canonical serialization, not a claim that the original request bytes were canonical.

#### POST /v1/renders

Renders an already-authored valid score without invoking an LLM.

Request:

- score: required score object;
- sourceJobId: optional accepted job whose historical compatibility row, custody profile, replay inputs, and expected hashes must be used;
- custodyProfileId: optional exact supported profile for a newly submitted score; required when more than one compatible current profile is available;
- packCustodyRef: optional exact immutable pack reference; otherwise a sample-backed score is resolved only by its embedded exact identity;
- mode: canonical or derivative, default canonical;
- outputs:
  - fullMix: const true;
  - stems: boolean, default false;
  - rpp: boolean, default false with the same stems rule as /songs;
- derivativeRecipe: required only for derivative mode and forbidden for canonical mode;
- execution: async or sync_wait settings.

The score's schemaVersion, kitVersion, seed, sampleRate, register, tracks, sections, samplePack, and sampleVoices are authoritative. Top-level or output fields named seed, sampleRate, bitDepth, or tailSeconds are rejected. With sourceJobId, the supplied canonical artifactSha256 must equal the saved score and the saved historical compatibility row/profile is mandatory. Without sourceJobId, admission selects the one exact compatible current row/profile and persists it; ambiguity is rejected. A canonical render uses that admitted custody profile and fixed canonical tail/PCM policy and accepts no per-request render override.

A derivativeRecipe may describe an explicitly noncanonical post-render or alternate-render operation, including its renderer identity, output sample rate, bit depth, channel layout, tail rule, and every other parameter that can affect bytes. The full recipe, source artifactSha256, and derivative output hashes are persisted. A derivative is never assigned or compared with the canonical song WAV hash and is never represented as canonical replay.

### 1.4 Honest error envelope

All failures use:

- error.code;
- error.message;
- error.retryable;
- error.stage;
- error.details;
- jobId, when applicable;
- validationErrors, when applicable; and
- artifactRefs only for clearly marked diagnostic artifacts.

The API never reports success after validation failure, required-pack failure, custody-profile failure, render failure, required-artifact failure, or incomplete provenance.

---

## 2. Composition pipeline

The pipeline is:

prompt → admission and immutable identity resolution → register artifact → LLM score authoring → strict validation with bounded repair → canonical custody render → artifact bundle

Every stage writes durable job state.

### 2.1 Admission, request satisfiability, and immutable resolution

Admission records the original request bytes and resolves:

- scoreSchemaVersion;
- generated or supplied score seed;
- model lane;
- exact pack identity and immutable snapshot, if requested;
- canonicalVoiceAllowlist and assetAllowlist;
- render output combination;
- compatibility-matrix row; and
- custody-render profile.

The resolved seed is placed in the composer contract and must be copied into the score. A candidate with any other seed is invalid. The score's fixed sampleRate must be 44100.

Duration fields describe musical duration before the custody tail. Numeric second fields must be finite numbers greater than zero and no greater than 3,600. targetBars and every requested section bar count must be integers from 1 through 4,096. When sections is present, its order maps one-to-one to score.sections: each requested name must equal that score section's track field, and each supplied bars value must equal that score section's bars field.

The deterministic duration rules are:

1. For a validated candidate, musical duration D is the existing score construction:

       D = sum over sections of section.bars × 16 × (60 / section BPM / 4)

   Section BPM is its referenced track's bpm, falling back to score tempo.

2. targetSeconds defines the closed acceptance interval targetSeconds plus or minus max(1 second, 2 percent of targetSeconds), intersected with the global greater-than-zero through 3,600-second range.
3. minSeconds and maxSeconds further intersect that interval. If no targetSeconds is given, they alone define the interval. minSeconds must not exceed maxSeconds.
4. Every requested section is binding by position and track name; every supplied section bars value is also binding. If targetBars is present, it is the binding total. When all requested sections supply bars, targetBars, if present, must equal their sum; otherwise their sum becomes the binding total.
5. For partial section bar constraints, let K be the sum of supplied bars and U the number of sections without bars. Admission permits total bars only in K + U through K + 4096 × U. A targetBars value must fall in that interval. A candidate must match every supplied section constraint and, when present, the binding targetBars total.
6. When seconds constraints exist, the service rejects an empty seconds-interval intersection before calling the LLM. For a binding total B, the seconds interval must intersect 0.6 × B through 12 × B seconds. For a partial permissible bar range Bmin through Bmax, it must intersect 0.6 × Bmin through 12 × Bmax seconds. These bounds derive from the supported 20-400 BPM range.
7. After each candidate, validation computes D exactly and requires it to be inside the admitted interval.
8. Section direction text that cannot map to a score-level predicate remains composition direction. loopable is likewise nonbinding direction text in this revision because the current score schema has no portable loopability predicate. It must not be reported as validator-proven.

Contradictions fail with INVALID_REQUEST before register tooling or the LLM runs.

Pack admission validates the entire M3 sidecar according to [M3-PACK-FORMAT.md](./M3-PACK-FORMAT.md), including exact format, formatVersion, packId, manifestSha256, contentSha256, every asset wavSha256 and pcmSha256, file inventory, and canonical WAV constraints. Any mismatch hard-fails before composition or render. A registry path is never used as continuing mutable input: successful admission copies or resolves the exact bytes into an immutable, content-addressed snapshot. The composer and renderer both use that same snapshot.

For policy preferred, absence of the exact requested identity may fall back to synthesis only when the request explicitly selected preferred. The resolution, changed allowlists, and fallback are persisted before composition. A different pack is never substituted.

### 2.2 Register resolution and score binding

The register describes tempo guidance, tonal or mode guidance, rhythmic attitude, voice palette, mood laws, density, allowed contrasts, prohibitions, and section behavior when relevant.

Sources:

- supplied: retain the caller's exact brief bytes;
- command: retain exact successful stdout as the brief; or
- neutral: use deterministic, API-versioned neutral text.

The neutral register uses conservative, register-neutral vocabulary and synthesis voices unless an exact pack was admitted. Historical extraction provenance is not default musical direction, consistent with register neutrality ([MISSION.md](../MISSION.md)). The brief command authors a register when the operator requests the operator's own vocabulary.

Before composition, the service turns the resolved brief into a score-valid immutable register artifact:

1. Compute SHA-256 over the exact UTF-8 brief bytes.
2. Set register.name to r- followed by the first 62 lowercase hexadecimal characters.
3. Set register.briefRef to docs/generated-registers/ followed by the full hash and .md.
4. Persist the exact bytes under that logical repository-relative path in the job's immutable source snapshot.
5. Retain the logical path and bytes in the replay bundle.

A hash collision with different retained bytes fails admission. No whitespace normalization changes the stored artifact. The composer receives the fixed register object and must copy it unchanged into the score. A different register name or briefRef is a validation error. On replay, the retained source snapshot supplies the same logical path; the service does not depend on the working tree still containing it.

The brief command is an external local tool. Its provenance includes configured profile, fixed executable, fixed argv, version if available, timestamp, exit status, stdout, bounded stderr or its hash, timeout, and fallback status.

If the brief command fails, the job fails with WEISS_FAILED unless allowNeutralFallback was explicitly true. Any fallback is visible in job events and provenance.

### 2.3 LLM score authoring

The composer receives a versioned, self-contained prompt contract containing:

1. the complete-score task;
2. exact scoreSchemaVersion;
3. relevant score-contract text;
4. canonicalVoiceAllowlist, typed only as House Band lanes;
5. assetAllowlist, typed as M3 asset IDs with wavSha256, pcmSha256, and allowed canonical lane bindings;
6. exact pack identity when admitted;
7. user prompt;
8. resolved brief and the fixed register object;
9. binding duration/bar constraints and nonbinding direction;
10. admitted seed;
11. strict output requirement: one complete JSON object, no prose, Markdown, comments, or trailing data; and
12. validation reminders.

The model may bind an allowed asset only to an allowed existing canonical lane. For the current sample tranche those lanes are kick, snare, and hat. It may not invent voices, assets, schema fields, renderer features, or pack identities.

The LLM is nondeterministic and excluded from render replay. Every exact model request and raw response is retained as an attempt artifact.

### 2.4 Strict validation and bounded repair

Every candidate passes:

1. a duplicate-aware JSON scan that rejects duplicate member names at any object depth;
2. parse as one JSON value with no trailing content;
3. strict validation against the admitted score schema;
4. equality checks for the admitted schema, seed, kit, register, and exact pack resolution;
5. semantic checks, including canonical voices, patterns, ranges, sections, and the admitted duration/bar predicates;
6. exact pack and asset binding checks; and
7. renderer preflight.

Version 1.1.0 is current. Version 1.0.0 is legacy synthesis-only. Strict validation is the implementation in [spec.mjs](../src/spec.mjs); the service may not loosen it for model output.

The raw model response is never the accepted score artifact. After validation, the service serializes the validated value as recursive sorted-key JSON with no insignificant whitespace and encodes that string as UTF-8 without a BOM or trailing newline. Those bytes are score.json. artifactSha256 is SHA-256 over exactly those bytes, matching the existing canonicalJson and artifactSha256 construction described in [DETERMINISM.md](./DETERMINISM.md) and implemented by [provenance.mjs](../src/provenance.mjs). All API fields named scoreHash or artifactSha256 refer to this construction.

Validation attempts are finite. Default maxValidationAttempts is 3; server configuration sets a finite upper bound. A repair request is stateless and contains:

- the immutable complete base prompt;
- the complete prior raw candidate;
- ordered validator diagnostics with stable paths;
- validation attempt number and maximum;
- the exact admitted constraints and identities; and
- a requirement to return one complete replacement score.

The exact request and response for every attempt are persisted. The service never relies on provider-side conversation state.

Provider transport behavior is separately bounded:

- each lane has maxTransportAttempts, a finite positive integer;
- each job has one total composition deadline;
- transport calls are serialized;
- each call has a unique requestId and timeout;
- a timed-out request can never race a later request into acceptance;
- a response received after its timeout or after cancellation is retained as late diagnostic data, deterministically discarded, and never counted as a validation candidate; and
- job state reports transportCallCount separately from validationCandidateCount.

After the final invalid candidate, the job fails with COMPOSITION_INVALID_AFTER_RETRIES. Exhausting transport attempts or the total deadline fails with MODEL_LANE_UNAVAILABLE or COMPOSITION_DEADLINE_EXCEEDED as applicable.

No musical or schema-level repair is performed silently.

### 2.5 Canonical custody rendering and derivatives

The canonical render consumes only:

- the immutable validated score artifact;
- the exact compatibility row and custody-render profile;
- the exact retained kit and renderer build; and
- the admitted immutable M3 snapshot when the score is sample-backed.

The persisted score is authoritative for seed, sampleRate, kitVersion, schemaVersion, register, arrangement, and sample bindings. There is no separate render seed or sample-rate override.

The current custody profile is a versioned exact record:

| Field | hb-custody-render/1.0.0 |
|---|---|
| profileFormatVersion | 1.0.0 |
| rendererBuild | house-band git 0953f41fb4e055e4d73ef358860e224280195e00 |
| Node | v25.9.0 |
| operating system | darwin |
| architecture | arm64 |
| WebAudio engine | node-web-audio-api 2.2.0 |
| sample rate | 44100 Hz |
| channel count/layout | 2, interleaved stereo left then right |
| encoder | House Band RIFF/WAVE PCM format 1 encoder from the pinned renderer build |
| sample representation | signed 16-bit little-endian PCM |
| dither | false |
| canonical tail policy | hb-custody-tail/1.0.0 |

The canonical tail policy is 1.45 seconds. For synthesis-only scores, total frames are ceil((musical duration + 1.45) × 44100). For sample-backed scores, musical frames are the sum of each section's independently rounded frame count, the base length adds exactly 1.45 × 44100 frames, and total frames are the maximum of that base length, the final referenced one-shot end frame, and one frame. Mix and every stem use the same total frame count.

The per-job custody profile record also contains the exact scoreSchemaVersion, kit semver and source SHA-256, renderer version/build identity, sample renderer version when used, encoder identity, and M3 identities. This covers every byte-stability boundary in [DETERMINISM.md](./DETERMINISM.md): Node release, operating system, architecture, WebAudio engine, encoder, sample rate, channel layout, kit, schema, and associated pinned render code. A changed boundary is a different profile and makes no cross-profile WAV-hash promise.

Required outputs are score.json, full-mix WAV, and manifest. Optional outputs are per-voice stems, RPP, and a bundle. Stems use one isolated pass per canonical voice from the same score, exact seed and profile; begin at frame zero; are sample-aligned; have identical full length including tail; and are covered as one set by the manifest, following [M2-INTERFACE.md](./M2-INTERFACE.md).

RPP is minimal plain text with project tempo, one named track per stem, all stems placed at zero, and section markers where representable. It contains no mixing, plug-in, or production assumptions.

Noncanonical derivative renders are separate artifacts. Their complete recipes and source artifactSha256 are retained, and their hashes are never called the canonical song hash.

### 2.6 Replay inputs and artifact bundle

A successful job retains every non-code input needed to replay its canonical render:

- canonical score bytes;
- exact register artifact bytes and logical briefRef;
- validation report;
- original admitted request and identity resolutions; and
- the complete exact M3 sidecar, including pack.json and every canonical asset, for a sample-backed score.

The sidecar may be embedded in the bundle or stored in an immutable content-addressed custody store keyed by both manifestSha256 and contentSha256. If stored separately:

- the bundle contains its exact custody-store reference and complete identity;
- retention is at least as long as the score, job record, and accepted artifacts;
- objects cannot be replaced in place;
- retrieval revalidates the manifest, inventory, files, and all hashes; and
- deleting the last retained replay input makes the associated accepted job ineligible for deletion-independent replay and is prohibited by the same retention policy.

Hashes alone are not replay inputs. A job does not succeed until all required non-code inputs have durable custody.

---

## 3. Artifact, provenance, and replay model

### 3.1 Persisted job contents

Each job persists:

- original request bytes and admitted normalized values;
- exact schema, seed, lane, compatibility row, custody profile, and pack resolution;
- register request, exact brief, logical briefRef, and tool metadata;
- exact model request and raw response for every transport attempt;
- ordered diagnostics for every validation candidate;
- canonical score.json and artifactSha256;
- validator version and validation report;
- canonical render metadata and hashes;
- exact pack identity, per-referenced-asset wavSha256 and pcmSha256, and custody reference;
- mix, stems, RPP, manifest, and provenance as applicable; and
- an external job index record.

Writes are atomic where practical. Failed jobs remain inspectable, with non-accepted artifacts labeled.

### 3.2 Manifest

The manifest includes:

- manifest format version;
- jobId and creation time;
- scoreSchemaVersion;
- artifactSha256;
- score seed and register;
- kit version and source SHA-256;
- renderer and exact custody-profile record;
- canonical tail/PCM settings;
- full-mix output SHA-256;
- stem hashes and common frame count, when present;
- RPP hash, when present;
- exact M3 format, formatVersion, packId, manifestSha256, contentSha256, and referenced asset hashes, when present;
- determinism scope note; and
- API version.

Browser-native manifests are environment-scoped. They may use the same shape but must identify the browser engine and must not claim the CLI custody WAV hash.

### 3.3 Provenance and non-circular hash domain

Provenance records the original prompt, resolved register, model lane and model, prompt-template revision, transport and validation attempts, final artifactSha256, exact pack resolution, score seed, custody profile, stage timestamps, and hashes for this closed domain:

- request artifact;
- register artifact;
- every composition request and response artifact;
- validation report;
- canonical score;
- canonical manifest;
- canonical full mix;
- canonical stems;
- RPP; and
- retained M3 pack.json and each retained canonical asset, when embedded.

The provenance hash domain explicitly excludes:

- provenance.json itself;
- bundle files or any other archive that encloses provenance; and
- the external job index.

After provenance bytes and bundle bytes exist, the external job index stores provenanceSha256 and bundleSha256. Neither value is inserted back into provenance or an enclosed file, so no self-inclusion cycle exists.

Credentials and secret-bearing headers are never persisted. Stored model requests redact only configured credential fields; musical and validation content remains exact.

### 3.4 Replay guarantee and failure classification

Canonical replay:

1. loads score.json and verifies artifactSha256;
2. selects the saved exact compatibility row and custody profile without migration;
3. verifies that the retained validator, kit, renderer, encoder, runtime, and M3 sidecar are available;
4. revalidates the score under its historical schema;
5. revalidates every exact pack and asset identity before allocating the audio graph;
6. renders from the immutable snapshot; and
7. compares canonical mix and stem hashes.

If any exact executable toolchain component or environment boundary is unavailable, replay fails before rendering with TOOLCHAIN_UNAVAILABLE. If an exact retained pack input is missing, it fails with PACK_MISSING; if any pack identity or byte differs, it fails with PACK_IDENTITY_MISMATCH before rendering.

RENDER_MISMATCH applies only after all saved inputs and the exact saved custody profile have been established and that same supported profile produces unexpected bytes. It is a custody failure. It is never used for an unsupported cross-environment comparison.

The LLM is not called during replay.

---

## 4. Configuration

### 4.1 Service configuration

Configuration includes:

- loopback bind address and port;
- allowed exact Host values;
- job output, temporary, cache, and immutable custody-store roots;
- artifact and replay-input retention policy;
- default score schema version, initially 1.1.0;
- retained compatibility rows and custody profiles;
- maximum concurrent jobs;
- maximum validation candidates;
- event-history retention; and
- sync-wait limits.

The unauthenticated profile has no configurable non-loopback escape hatch.

### 4.2 Model lanes

Each lane has:

- laneId and display name;
- OpenAI-compatible base URL;
- credential environment variable name or secret reference;
- model id and generation parameters;
- context/output limits;
- per-call timeout;
- finite maxTransportAttempts;
- total composition deadline;
- JSON-output capability notes; and
- enabled state.

Calls are serialized per job as specified in Section 2.4. Provenance stores lane and model identities but not credentials.

### 4.3 Brief command process boundary

Brief command configuration uses:

- one fixed absolute executable path;
- one fixed argv vector containing only configured literal arguments;
- profile/model name;
- fixed working directory;
- timeout and maximum stdout/stderr bytes;
- optional fixed version command; and
- explicit fallback policy.

The service spawns the executable directly with shell:false. Prompt, constraints, and pack summary are written as a bounded stdin payload. No caller or model text is interpolated into an executable path, argv template, environment-variable name, or shell command string. Shell aliases and command-string templates are forbidden.

### 4.4 Pack registry

Registry entries are validated M3 identities, not release ranges. Each entry includes exact format, formatVersion, packId, manifestSha256, contentSha256, pack.json, all asset metadata and hashes, compatibility rows, and a custody snapshot reference.

Separate typed allowlists are mandatory:

- canonicalVoiceAllowlist contains House Band voice IDs; and
- assetAllowlist contains M3 asset IDs and resolves to exact asset hashes and permitted lane bindings.

No pack requested means synthesis-only composition. A required unavailable exact identity fails before the LLM. A preferred unavailable exact identity may fall back only as explicitly admitted and recorded. The LLM never sees mutable registry paths.

### 4.5 Output directories and immutability

Each admitted job gets an immutable logical snapshot and an append-only output area for:

- request and admission;
- register;
- composition attempts;
- score and validation;
- pack sidecar or custody reference;
- renders and stems;
- RPP;
- manifest and provenance;
- derivatives; and
- bundle.

An accepted artifact is never overwritten in place.

---

## 5. Failure modes

### 5.1 Error codes

INVALID_REQUEST  -  malformed request, contradictory duration/bar constraints, invalid output combination, duplicate JSON keys, or unsupported fields.

UNSUPPORTED_SCORE_SCHEMA  -  exact requested schema is unsupported.

MODEL_LANE_UNAVAILABLE  -  lane disabled, unreachable, or transport attempts exhausted.

COMPOSITION_DEADLINE_EXCEEDED  -  total composition deadline elapsed.

WEISS_FAILED - fixed brief command process missing, timed out, failed, or returned an empty brief.

PACK_MISSING  -  exact required pack or retained pack input unavailable.

PACK_INCOMPATIBLE  -  exact pack is not in the admitted schema/renderer compatibility row.

PACK_IDENTITY_MISMATCH  -  format, formatVersion, packId, manifestSha256, contentSha256, file inventory, wavSha256, pcmSha256, or score binding differs. Always pre-render.

COMPOSITION_INVALID_AFTER_RETRIES  -  finite validation-candidate limit reached.

TOOLCHAIN_UNAVAILABLE  -  exact historical validator, kit, renderer, encoder, runtime, operating system, architecture, audio engine, or custody profile cannot be provided. This is not a render mismatch.

RENDER_FAILED  -  supported exact toolchain began a render but could not produce required output.

RENDER_MISMATCH  -  the exact supported saved profile and inputs rendered bytes that differ from the saved canonical hashes.

ARTIFACT_WRITE_FAILED  -  a required artifact or replay input could not be retained.

EVENT_CURSOR_EXPIRED  -  requested SSE history can no longer be replayed contiguously.

JOB_CANCELED  -  operator cancellation completed.

HTTP status selection is consistent across endpoints: request/schema failures use 400 or 422; missing dependency or compatibility failures use 409, 424, or 503; internal custody failures use 500.

### 5.2 Partial and derivative outputs

Invalid drafts, late model responses, logs, and partial renders are diagnostic artifacts only. Derivative renders are valid derivative artifacts but are not canonical song outputs. Neither category can satisfy a successful prompt-to-song job's required canonical artifact set.

---

## 6. Versioning and compatibility

### 6.1 Independent version namespaces

The API path, score schema, prompt template, register template, validator, kit, renderer, sample renderer, M3 pack format, custody-render profile, custody-tail profile, manifest, and bundle format have independent version identities.

The current score schema is 1.1.0. The 1.0.0 schema remains available only for legacy synthesis scores. This is the source-of-truth relationship in [version.mjs](../src/version.mjs) and [spec.mjs](../src/spec.mjs).

### 6.2 Score identity law

The accepted canonical sorted-key UTF-8 score bytes are the song's musical identity. Strict validation and artifactSha256 use those bytes. The service does not:

- hash a raw LLM response as the accepted score;
- preserve duplicate keys;
- invent or remove score fields;
- bypass strict mode;
- accept conflicting render overrides; or
- hide musical state in API/UI-only values.

The Audition Room may write a new valid score after a tweak. That produces a new artifactSha256; unchanged values round-trip semantically, while raw incoming whitespace and key order are not part of identity.

### 6.3 Explicit current compatibility matrix

The minimum current matrix is:

| score schema | capability | exact kit | renderer build | custody profile | pack requirement |
|---|---|---|---|---|---|
| 1.0.0 | legacy synthesis only | 1.1.0 + b2709519f2faf8481de28e0a5e9912cd2e80ae9e290fdfca88915c0377aaf773 | git 0953f41fb4e055e4d73ef358860e224280195e00 | hb-custody-render/1.0.0 | sample fields forbidden |
| 1.1.0 | synthesis | 1.1.0 + b2709519f2faf8481de28e0a5e9912cd2e80ae9e290fdfca88915c0377aaf773 | git 0953f41fb4e055e4d73ef358860e224280195e00 | hb-custody-render/1.0.0 | none |
| 1.1.0 | M3 one-shot samples on canonical kick/snare/hat lanes, with optional synthesis | 1.1.0 + b2709519f2faf8481de28e0a5e9912cd2e80ae9e290fdfca88915c0377aaf773 | git 0953f41fb4e055e4d73ef358860e224280195e00 plus sample renderer 1.0.0 | hb-custody-render/1.0.0 | house-band-sample-pack 1.0.0 exact identity |

Additional rows require explicit publication and capability advertisement. A row is selected once at admission and persisted.

The service retains validators, kit code, renderer/encoder builds, runtime images or equivalent exact execution environments, and routing for every accepted job for at least the job's artifact-retention lifetime. Versions run side by side. Replay routes to the saved row; it never upgrades, downgrades, rewrites, or implicitly migrates an old score. If the row cannot execute exactly, replay fails with TOOLCHAIN_UNAVAILABLE.

### 6.4 Exact M3 identity

The API-level admitted identity is:

- format;
- formatVersion;
- packId;
- manifestSha256;
- contentSha256; and
- for every score-referenced asset, manifest id, score-binding assetId, wavSha256, pcmSha256, and allowed canonical lane.

The score's schema-supported samplePack reference carries packId, formatVersion, manifestSha256, and contentSha256. Its sampleVoices object binds an existing canonical lane to an assetId and pcmSha256. Pre-render validation joins that reference to the retained manifest and also verifies format and each asset's wavSha256. Every mismatch is a hard failure; there is no warning-only identity mismatch.

---

## 7. Minimal UI hook and browser parity law

A thin UI can discover capabilities and packs, submit prompts, follow SSE progress, display honest errors, download artifacts, validate edits, and request rerenders without redesigning this API.

The M2 Audition Room remains a score-artifact consumer. It loads and validates score JSON, auditions and tweaks, writes a new score artifact, and exports browser-scoped audio. The CLI custody path remains authoritative for shipped audio, as specified by [M2-INTERFACE.md](./M2-INTERFACE.md).

Browser/CLI parity means:

- the same canonical artifactSha256;
- the same score seed;
- the same schema and exact kit metadata;
- the same exact M3 identity and referenced asset metadata, when used; and
- the same score-derived structure.

WAV hashes are compared only when both entry points invoke the exact same pinned custody renderer under the same custody profile. Native browser OfflineAudioContext output is environment-scoped and is never required to equal CLI custody WAV bytes, consistent with [DETERMINISM.md](./DETERMINISM.md). A browser metadata mismatch is a parity failure; a browser-native WAV difference alone is not RENDER_MISMATCH.

---

## 8. Test plan

### 8.1 Admission and request tests

Cover:

- request field types, sizes, unknown fields, and duplicate keys;
- scoreSchemaVersion default 1.1.0;
- explicit 1.0.0 synthesis success and 1.0.0 pack-request rejection;
- duration interval intersection, target tolerance, bar-total precedence, feasible BPM bounds, and pre-LLM contradiction rejection;
- loopable recorded as nonbinding direction;
- required full mix;
- rpp implying stems only when stems is omitted;
- explicit rpp:true/stems:false rejection;
- exact pack identity only, with range syntax rejected;
- exact model lane and custody profile selection; and
- no register tool or model call after failed admission.

### 8.2 Security and process tests

Cover:

- unauthenticated non-loopback bind refusal;
- Host and Origin allow/reject cases;
- absence of cross-origin headers;
- forwarded-header non-trust;
- brief command direct spawn with shell:false and fixed argv;
- prompt supplied only over bounded stdin; and
- metacharacters in prompt never changing the executable or argv.

### 8.3 Register tests

For supplied, command, fallback, and neutral paths:

- exact brief bytes retained;
- deterministic hash slug and briefRef;
- logical docs path is score-valid;
- composer receives one fixed register object;
- candidate mutation of register fails;
- replay resolves the bundled logical path without relying on the current working tree; and
- neutral vocabulary conforms to register neutrality ([MISSION.md](../MISSION.md)).

### 8.4 Composition, parsing, and repair tests

Using mocked lanes:

- first valid candidate succeeds;
- malformed JSON and duplicate keys fail;
- raw responses remain attempt artifacts only;
- accepted score is canonical sorted-key UTF-8;
- artifactSha256 is stable across input whitespace and key order;
- repair calls contain immutable base prompt, complete prior candidate, ordered diagnostics, attempt number, and complete-output rule;
- exact request and response persist for every call;
- validation-candidate bound and finite transport bound are independently enforced;
- calls are serialized;
- timed-out late responses cannot win;
- counters distinguish transport calls from candidates; and
- no render follows final validation failure.

### 8.5 Pack identity and snapshot tests

Cover every M3 identity component independently:

- format;
- formatVersion;
- packId;
- manifestSha256;
- contentSha256;
- exact file inventory;
- per-asset wavSha256;
- per-asset pcmSha256;
- assetId;
- canonical lane binding; and
- canonical WAV constraints.

Every mismatch must fail before render. Mutation or replacement of an installed registry path after admission must not affect the composer or renderer, which use the admitted immutable snapshot. Pack assets must never appear as invented canonical voice IDs.

### 8.6 Canonical render and replay tests

Within hb-custody-render/1.0.0:

- render the same canonical score twice and compare mix hashes;
- render stems twice and compare every stem hash;
- verify common frame count, alignment, and tail policy;
- verify manifest hashes;
- replay without an LLM;
- reject seed, sampleRate, bitDepth, and tail overrides;
- verify derivatives retain a complete recipe and never claim canonical identity;
- verify every DETERMINISM boundary is present in the saved profile;
- report TOOLCHAIN_UNAVAILABLE when an exact boundary or executable is absent; and
- reserve RENDER_MISMATCH for unexpected bytes within the exact available profile.

### 8.7 Browser/CLI parity tests

For one canonical score:

- compare artifactSha256, seed, schema, kit, and exact pack/asset metadata between CLI and Audition Room;
- do not compare native browser and CLI WAV hashes;
- compare WAV hashes only when both surfaces delegate to the same pinned custody renderer/profile; and
- treat metadata drift as release-blocking.

### 8.8 Artifact, provenance, and retention tests

Assert:

- all required request, register, attempt, score, validation, manifest, audio, and pack inputs exist;
- raw LLM output is not score.json;
- provenance contains exactly the enumerated hash domain;
- provenance excludes its own hash and every enclosing archive hash;
- the external job index contains provenanceSha256 and bundleSha256;
- secrets are absent;
- a sample-backed job retains its exact sidecar or durable content-addressed object;
- custody-store retention is not weaker than score retention; and
- missing replay inputs prevent job success or later fail honestly, never approximately.

### 8.9 Compatibility and migration tests

For every matrix row:

- route to the exact validator, kit, renderer, encoder, runtime, and profile;
- run legacy 1.0.0 as synthesis-only;
- run current 1.1.0 with and without exact M3 assets;
- keep side-by-side rows isolated;
- reject an implicit schema or renderer migration; and
- return TOOLCHAIN_UNAVAILABLE when a saved row is absent.

### 8.10 RPP and event-stream tests

RPP tests verify one track per stem, placement at zero, score tempo, representable section markers, and warning-free REAPER opening without plug-in assumptions.

SSE tests verify media type, monotonically increasing persisted IDs, ordered replay, Last-Event-ID and after semantics, cursor-gap failure, heartbeat framing, live continuation, one terminal event, terminal close, terminal replay, cancellation, and the job record's authority.
