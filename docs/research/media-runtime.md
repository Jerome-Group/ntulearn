# Local media runtime dependency notes

The media runtime is deliberately not a package or a checked-in binary. `media.setup` pins the
Owner's selected artifact by source, revision, SHA-256 and licence, and `npm run media:setup`
places the verified copy under the RAID0 Media store.

## Selected components

| Role | Component | Licence note | Upstream |
|------|-----------|--------------|----------|
| Media tooling | FFmpeg | FFmpeg is LGPL-2.1-or-later by default; builds with optional GPL components change that obligation. Record the actual build's licence in `media.setup.mediaTool.license`. | [FFmpeg legal considerations](https://ffmpeg.org/legal.html) |
| ASR runtime | whisper.cpp | The upstream project is MIT licensed. A downloaded Whisper model is a separate artifact and must carry its own recorded licence. | [whisper.cpp README](https://github.com/ggml-org/whisper.cpp/blob/master/README.md) |
| Formatter runtime | llama.cpp | The upstream project is MIT licensed. | [llama.cpp README](https://github.com/ggml-org/llama.cpp/blob/master/README.md) |
| Formatter model | Qwen3 1.7B GGUF, selected 4-bit file | The official Qwen3 1.7B GGUF repository publishes the model under Apache-2.0. Record the exact quantization file and digest used. | [Qwen3 1.7B GGUF](https://huggingface.co/Qwen/Qwen3-1.7B-GGUF) |

## Owner benchmark record — 2026-08-16

An Owner-supervised run used whisper.cpp 1.9.2 on the Apple M4 with `-l en -fa -sns -t 8`. The
real fixture was a 143.44-second local CC0003 lecture; its course-term score covered 14 required
terms after harmless spacing/case normalization. Because that lecture contains no mathematics,
the math score used a separate 18.85-second Owner-generated spoken fixture covering derivatives,
integrals, a quadratic, and a matrix; equivalent spoken/digit forms count as the same notation.
Timestamp score means ordered segments ending within `duration + max(2s, 5%)`; throughput is
lecture duration divided by wall time.

| Model | Course terms | Math utterance | Timestamps | Lecture throughput | Selected |
|---|---:|---:|---:|---:|---|
| `small.en` | 1.00 | 1.00 | 1.00 | 30.13x | yes |
| `medium.en` | 1.00 | 1.00 | 1.00 | 12.64x | no |
| `large-v3-turbo` | 1.00 | 1.00 | 1.00 | 15.32x | no |

Pinned model SHA-256 values were `c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d`,
`cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da435`, and
`1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69`, respectively. Runtime
metadata records the selected `small.en` identity, model pin, evaluation metrics, and selection
reason; media, transcripts, and model files stay outside Git under the Owner's RAID0 benchmark
scratch.
