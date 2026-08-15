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

The issue's pilot comparison remains a later media-workflow task: `small.en`, `medium.en` and
`large-v3-turbo` are choices to measure, not weights this repository vendors. No model, cache,
runtime build or lecture artifact belongs in Git.
