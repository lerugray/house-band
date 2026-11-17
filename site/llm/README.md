# After Closing: one LLM run, start to finish

The landing page's "An LLM writes the score" section shows this run. Everything here is the real record.

| file | what it is |
|---|---|
| `after-closing.request.json` | the song request sent to the House Band API (prompt, direction brief, three sections, seed) |
| `after-closing.prompt.json` | the exact system and user messages the model received (Composer's Desk prompt template `hb-composer/1.2.0`, built by `src/api/provider.mjs`) |
| `after-closing.brief.txt` | the direction brief as the API stored it |
| `after-closing.model-output.json` | the score the model returned, byte for byte |
| `after-closing.validation.json` | the format check report: valid on the first candidate |

The model was Claude. The API rendered the accepted score on the listen profile, and
`node bin/house-band.mjs render site/llm/after-closing.model-output.json -o after-closing.wav` writes the
same WAV bytes. The page audio (`site/audio/llm/`) is that WAV trimmed at 39.4 s (the pad tail has died away)
and level-matched to -18 LUFS for the page.

Run it yourself: open `audition-room.html?score=llm/after-closing.model-output.json` on the site, or
start the Desk (`npm run desk-server`) with any provider profile and write your own prompt.

Licence: CC BY 4.0 with the site; credit Ray Weiss and House Band.
