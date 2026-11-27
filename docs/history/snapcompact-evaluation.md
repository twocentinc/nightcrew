# SnapCompact local evaluation

> Historical report. This records the dated experiment below, not current setup instructions or validation of the current release.

## Upstream renderer rerun, November 12, 2026

The initial evaluation below used an approximation. The blog's stale link was
not evidence that the upstream research was unavailable: the repository is
now `can1357/oh-my-pi`, branch `main`. This rerun uses its actual research code
and bitmap fonts, pinned to commit
`238878f131787ada2b5d35409b4ee759cc535419`.

Sources:

- [Research renderer, bdf.py](https://github.com/can1357/oh-my-pi/blob/238878f131787ada2b5d35409b4ee759cc535419/packages/snapcompact/research/bdf.py)
- [Monolithic research harness](https://github.com/can1357/oh-my-pi/blob/238878f131787ada2b5d35409b4ee759cc535419/packages/snapcompact/research/mono.py)
- [Document renderer parity reference](https://github.com/can1357/oh-my-pi/blob/238878f131787ada2b5d35409b4ee759cc535419/packages/snapcompact/research/parity_check.py)
- [Document wrapping research](https://github.com/can1357/oh-my-pi/blob/238878f131787ada2b5d35409b4ee759cc535419/packages/snapcompact/research/exp14_bestgpt.py)

### Observed results

Same Qwen3.5-4B Q4_K_M model, installed projector, synthetic fixture and
18-field scorer as the first trial. Text and summary baselines were rerun.

| Carrier | Exact fields correct | Answer input tokens | Answer elapsed |
| --- | ---: | ---: | ---: |
| Original text | 18/18 | 9,501 | 39.2 s |
| Generated summary | 15/18 | 336 | 8.7 s |
| Upstream 6x12-dim | 7/18 | 5,012 | 36.8 s |
| Upstream 8x8r-bw, repeated lines | 4/18 | 5,046 | 36.4 s |
| Upstream 8on16-bw | 11/18 | 5,011 | 36.2 s |
| Upstream 8on22-bw | 16/18 | 7,414 | 48.8 s |
| Upstream doc-8on16-bw | 12/18 | 5,023 | 36.1 s |
| Upstream doc-8on16-sent-dim | 11/18 | 5,023 | 34.3 s |

Summary generation took another 34.8 s (9,833 input tokens, 180 output tokens),
for 43.5 s combined generation and answer time. Rendering is excluded from
the table. First calls in each isolated process include model preparation, so
these wall times are not controlled steady-state throughput measurements.

The best image condition, `8on22-bw`, reduced answer input tokens by about 22%
relative to text, but changed the raw timestamp from `1793912548959` to
`1739312548959` and lint status from passed to pending. It selected "prepare
release" instead of the required next step, running tests. The summary omitted
the timestamp, its unit, and evidence ID; its answer returned null for those
fields and correctly selected running tests next.

Other image configurations misread counts, identifiers, and task state. For
example, `8on16-bw` said tests passed when they had not run. Its exact score also
counts `PASS` versus `passed` for lint as a mismatch; accepting that synonym
would raise it to 12/18 without changing the conclusion. Both document layouts
misread sample counts and the timestamp, damaged the recovery/evidence IDs,
and missed the next action. The next-action check remains separate from the
18-field exact score. No side effects were executed by the model.

### Reproduction and scope

The four grid conditions call unmodified upstream `bdf.render`. Fonts are the
upstream bundled `6x12.bdf`, `8x13.bdf`, and `unscii-8.hex`, not platform fonts.
Document conditions call the exact `render_research` function from
`parity_check.py` with the exact `wrap` function from `exp14_bestgpt.py`.
Those two function definitions were loaded with Python AST compilation to
avoid importing unrelated cloud-provider runners; their bodies were not edited.
This uses upstream's production-parity reference document renderer, not the
native Rust package or the full cloud SQuAD benchmark.

Whitespace was collapsed identically for all carriers, as in upstream's
research flow; the complete source is 34,829 characters. Every character has
a font glyph, and page chunks were checked to reconstruct the whole source.
Frames remain the research renderer's full 1568-by-1568 squares, rather than
production's height-trimmed final frames. `8on22-bw` uses three images; all other
image conditions use two. Layout guides explain row/column order and repeated
lines; the same system instructions and JSON CHECK questions are used across
conditions. Upstream's numbered-answer SQuAD prompt was not substituted for
Nightcrew's JSON fixture. All calls use thinking off and temperature zero.

The existing host Python environment already included Pillow; no dependency
was installed. The daemon was idle before each isolated trial and restored
afterward. The public image-attachment contract and production compaction
implementation were not changed. One fixture and one pass per condition do
not establish results for larger models, other vision stacks, repeated
compaction, or real-task continuation. Within this test, actual upstream
rendering does not justify replacing the current summarizer on Qwen 4B.

Temporary evidence (subject to system cleanup):

- `/tmp/snapcompact-upstream/provenance.json`: pinned source/font SHA-256 hashes.
- `/tmp/snapcompact-upstream/manifest.json` and `manifest-doc.json`: layouts,
  source hash, PNG paths, document-function provenance.
- `/tmp/snapcompact-upstream/render_fixture.py` and `render_doc_fixture.py`:
  wrappers around the upstream functions, with full-coverage assertions.
- `/tmp/snapcompact-upstream/trial.mjs` and `trial-doc.mjs`: local inference adapters.
- `/tmp/nightcrew-snapcompact-upstream-Yt7tGg/results.json`: fresh baselines
  and four grid conditions, including raw answers.
- `/tmp/nightcrew-snapcompact-upstream-ozFdGK/results.json`: document conditions.

## Earlier approximation trial

Evaluated November 12, 2026 with owner-authorized inference on the installed
Qwen3.5-4B Q4_K_M model and its existing vision projector. Production compaction
was not changed. The idle daemon was stopped for isolated runtime trials and
restored afterward; its normal restart cooldown remains in effect.

## Result

This trial does not support replacing text-summary compaction with image
carriers. Dense images retained more of the scored fields than the summary,
but introduced false state and malformed identifiers. Larger text improved
accuracy while eliminating the observed context savings.

| Carrier | Exact fields correct | Answer input tokens | Answer elapsed |
| --- | ---: | ---: | ---: |
| Original text | 18/18 | 9,512 | 37.6 s |
| Generated summary | 14/18 | 300 | 7.0 s |
| Dense images, 2 pages | 15/18 | 4,974 | 34.8 s |
| Larger text images, 4 pages | 17/18 | 9,780 | 63.6 s |

Summary generation separately took 33.1 s, with 9,843 input tokens and 144
output tokens. Its combined generation-plus-answer time was 40.1 s. Image
rendering was outside the recorded inference times. Initial model preparation
is included in the first text call and in the separate larger-image trial;
these are observed wall times, not controlled steady-state latency benchmarks.

The summary omitted the raw timestamp, timestamp unit, recovery ID, and
evidence ID; the answering model returned null for those fields. Dense images
changed `published: false` to `true`, transposed digits in the recovery ID, and
dropped the `evidence-` prefix. Larger images fixed publication state and the
recovery ID, but still dropped the evidence prefix. Both image answers selected
asking for deployment approval as the next step, skipping the required tests.
That workflow error is additional to the 18-field score. Text and summary
answers correctly selected running tests next.

## Method and limits

Reused the existing synthetic live-compaction fixture from
`/tmp/nc-live-setup.json` and its CHECK request from `/tmp/nc-live-check.json`.
It includes corrections, sample/population boundaries, an exact timestamp,
identifiers, pending authorization, and an untrusted quoted instruction.
The text attachment was decoded into the shared source. Filler newlines were
normalized to spaces identically for every carrier. Total source length was
34,829 characters, including 600 repetitive archival markers. CHECK filler was
omitted for every condition. The summary used the current example summarizer
prompt, a 1,000-token target, and a 1,536-token output cap. Answers had a
700-token output cap. All calls used temperature zero with thinking disabled.

This is a reproduction of the optical-context approach described in
[Stencil's SnapCompact post](https://stencil.so/blog/snapcompact), not a test of
its exact implementation. The linked upstream research directory returned 404
at evaluation time. The temporary renderer used already-installed Sharp from
the host checkout, with no dependency installation or Nightcrew dependency
change. It rasterized black Menlo text on white 1568-by-1568 PNG pages:

- Dense: 13 px font, 16 px line spacing, 190 characters per line, 96 lines/page.
- Larger: 16 px font, 20 px line spacing, 150 characters per line, 76 lines/page.

These fonts are not the upstream bitmap fonts or a calibrated implementation
of its patch alignment and repetition optimizations. Each condition ran once
on one synthetic fixture. Most facts are near the beginning, with the owner
and ticket correction after the filler. No repeated-compaction endurance,
real-task continuation, memory measurement, or font sweep was performed.
Scores compare 18 predeclared fields, normalizing case and the optional Unix
prefix on milliseconds; they do not measure overall task completion.

Nightcrew's public attachment contract currently excludes images, and its
runtime formats attachments as text. The temporary harness overrides only the
isolated runtime's message formatter to submit actual image_url content to
llama.cpp. It does not exercise checkpoint persistence or the production
compaction handler with images. Existing 22 compaction tests passed against
the existing build; `npm run lint` also passed. These mocked tests establish
mechanical behavior, not model recall.

## Local evidence

Temporary artifacts may be removed by system cleanup:

- `/tmp/snapcompact-trial.mjs`: original-text, summary, and dense-image harness.
- `/tmp/snapcompact-trial-large.mjs`: larger-font follow-up harness.
- `/tmp/nightcrew-snapcompact-SxLfhF/results.json`: main results and answers.
- `/tmp/nightcrew-snapcompact-JPtvnF/results.json`: larger-font results.
- Both result directories contain the exact source and rendered PNG pages.

An initial attempt failed during slot takeover before any model answer; its
artifacts are under `/tmp/nightcrew-snapcompact-WYRNmU`. The harness was changed
to make independent, nonpersistent requests with complete message histories.
The daemon was restored after the failure as well as after successful trials.

Before adoption, test the upstream renderer or a faithful equivalent on a
broader corpus with progress/cursor corrections, exact identifiers, negative
facts, repeated compaction, and actual next-action execution. Critical state
and exact identifiers should remain available as text and original evidence.
