# Samples From Mars example mappings

[Samples From Mars](https://samplesfrommars.com/) sells commercial sample libraries.
House Band does **not** ship any of that audio. These files are build mappings only:
which relative paths inside *Essential WAV From Mars* become which pack assets, plus
the SHA-256 hashes Ray's private build recorded so you can rebuild byte-identical packs.

## One command

Point `--input` at the folder the mapping expects (see each file's `libraryRootHint`):

```bash
node tools/samples/build-mapping.mjs \
  --mapping examples/sample-mappings/samples-from-mars \
  --input "/path/to/folder/that/contains/Essential WAV From Mars" \
  --out ~/.house-band/packs
```

That builds the seven `tv-kit-*` packs. For `m3-tr606-demo`, source paths start at
`Drums/`, so pass the Essential WAV From Mars folder itself as `--input`.

Default `--out` is the first entry of `$HOUSE_BAND_PACKS`, otherwise `~/.house-band/packs`.
The tool refuses to write into this repo's `sample-packs/`.

## Edition mismatch

If your library edition differs from the one used to pin these hashes, `build-mapping`
prints `edition mismatch for <packId>:` and lists every source that is missing or whose
bytes do not match `expectedSourceSha256`, then skips that pack (exit code 1). Fix the
paths or obtain the matching edition; a different commercial drop will not rebuild
Ray's packs.

## Kits that work after a successful build

Once the packs are installed on the search path, these seven kit presets use them
unchanged: `cr78`, `dystopian-tech`, `found-wood`, `linndrum`, `synare-sds`, `tr707`,
`vinyl-indie`.

Regenerate the committed `.mapping.json` files (private tree only, where
`sample-packs/<id>/pack.json` exists) with:

```bash
node tools/samples/make-from-mars-mappings.mjs
```
