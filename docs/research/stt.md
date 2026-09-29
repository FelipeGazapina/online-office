# R4. Speech to text for push-to-talk and proximity

Research unit R4 for the beta. Written 2026-09-29. Versions checked: whisper.cpp 1.8.4 from Homebrew (ggml 0.13.0), Electron 44.4.5 (Chrome 152, Node 24.21.0), `@ricky0123/vad-web` 0.0.31 with onnxruntime-web 1.30.0. Machine: MacBook Air (Mac16,13), Apple M4 with 10 cores, 16 GB, macOS 26.6.2.

The question was which local engine turns the owner's speech into text for push-to-talk (hold V) and proximity (always listening within 1.5 m). The owner speaks English and Brazilian Portuguese. The engine has to work on this Mac today and have a path to Linux and Windows.

## Answer

Use whisper.cpp's `whisper-server`. The Electron main process starts it, keeps it resident, and posts WAV audio to it over `127.0.0.1`. The default model is `ggml-small-q5_1.bin` (190 MB). The language is a setting with three values, English, Portuguese or auto-detect.

**Latency on this Mac.** Warm, the server takes 0.33 s (median, 0.27 s best) for a 3 to 6 s utterance when the language is set, and 0.60 s with auto-detect. Through an Electron pipeline fed by Chromium's fake microphone (AudioWorklet buffer, IPC, HTTP, whisper), the time from releasing V to the text was 0.31 to 0.38 s with the language set and 0.53 to 0.62 s with auto-detect. Proximity mode adds the VAD hangover of 0.6 s, which makes about 1.2 s from end of speech with auto-detect and about 1.0 s with a language set. Push-to-talk is well under the 1.5 s budget. Proximity is under it with less margin.

**What small costs.** `small-q5_1` mishears code words. It wrote "PostGurse" for Postgres and "pulo request" for "pull request". Its word error rate (WER) was 0.11 on six clean clips and 0.26 on six held-out jargon phrases. `ggml-large-v3-turbo-q5_0.bin` (574 MB) scored 0.04 and 0.23 and got all three clean Portuguese clips exactly right, but warm it takes 1.36 s with the language set and 2.97 s with auto-detect. That misses the budget. Offer it as an opt-in high-accuracy setting for push-to-talk, with the language set. Auto-detect costs a second encoder pass, which is why it doubles turbo.

**whisper-server and brew.** `whisper-server` ships with the Homebrew formula. `brew install whisper-cpp` puts `whisper-cli`, `whisper-server`, `whisper-stream` and six other tools in `/opt/homebrew/bin`. Homebrew now names the formula `whisper.cpp` and keeps `whisper-cpp` as an old name. Here it is 1.8.4, while Homebrew lists 1.9.4 as stable. Run it like this, then POST a 16 kHz mono WAV as multipart form data to `/inference`:

```
whisper-server -m ~/Library/Caches/online-office/whisper/ggml-small-q5_1.bin -l auto -t 4 -bs 1 -bo 2 \
	--host 127.0.0.1 --port 8190 --vad -vm ~/Library/Caches/online-office/whisper/ggml-silero-v5.1.2.bin
```

Send `response_format=json`. `verbose_json` nearly doubles the latency because the server runs one more encoder pass to build language probabilities (turbo-q5_0 1.56 s to 2.75 s, small-q5_1 0.27 s to 0.49 s, same clip). The cost is the probabilities. With `no_language_probabilities=true` small-q5_1 dropped back to 0.32 s, but then the response has no detected language either. A Dock-launched app does not find Homebrew, because its `PATH` is `/usr/bin:/bin:/usr/sbin:/sbin` (read from the running Slack and Wispr Flow processes). Look in `/opt/homebrew/bin` and `/usr/local/bin` as well, then ask the login shell.

**Microphone in Electron dev mode on macOS.** `webkitSpeechRecognition` exists and fails with a `network` error, so it is unusable. `getUserMedia({audio:true})` needs no permission handler and no entitlement in dev mode. It resolved in 415 to 479 ms with the built-in mic. But every sample it delivered was exactly zero, `systemPreferences.getMediaAccessStatus('microphone')` stayed `not-determined`, and `systemPreferences.askForMediaAccess('microphone')` returned `false` after 21 ms with no dialog. So a resolved `getUserMedia` does not prove audio is flowing. Ask for access explicitly, and check that the first second of samples is not all zeros. I could not observe the TCC dialog headless, so the first interactive `pnpm dev` run has to confirm it. Section 3 has the details.

**Capture pipeline and VAD.** Capture with an AudioWorklet in a 16 kHz `AudioContext`. It repacks audio into 32 ms Int16 blocks that go into a 60 s ring buffer in the renderer. Push-to-talk slices the ring from 0.2 s before the press to the release. Proximity mode uses Silero VAD through `@ricky0123/vad-web` to find utterances. A plain energy VAD false-triggered on four of the five non-speech sounds I tried (thump, chord music, vacuum-like noise, alarm beeps, but not keyboard clicks), and Silero on none. Start `whisper-server` with `--vad` too, so a false trigger returns an empty string in about 10 ms instead of a hallucination. Half duplex handles the agents' own voices. Pause listening from `utterance.onstart` until 400 ms after `onend`. In my scene the leaked TTS was transcribed as a phantom owner utterance by both VADs without the gate and never with it. The code sketch is in section 6.

### Models compared

Latencies are warm `whisper-server` medians over 18 requests (six clips, three repeats) with `response_format=json`. WER is the mean over the six clean clips with the language set. Held-out is six new phrases in other voices (see Test setup).

| Model | Download | Warm, language set | Warm, auto | WER clean | WER held-out | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| `ggml-base-q5_1` | 60 MB | 0.09 s | 0.15 s | 0.21 | 0.39 | CPU-only fallback |
| `ggml-base` | 148 MB | 0.13 s | 0.17 s | 0.37 | not run | Worse than base-q5_1 |
| `ggml-small-q5_1` | 190 MB | 0.33 s | 0.60 s | 0.11 | 0.26 | Default |
| `ggml-small` | 488 MB | 0.35 s | 0.58 s | 0.15 | 0.35 | No gain over q5_1, 2.6 times the download |
| `ggml-medium-q5_0` | 539 MB | 1.01 s | 1.85 s | 0.08 | 0.30 | Beaten by turbo-q5_0 |
| `ggml-large-v3-turbo-q5_0` | 574 MB | 1.36 s | 2.97 s | 0.04 | 0.23 | Opt-in high accuracy |
| `ggml-large-v3-turbo-q8_0` | 874 MB | 1.52 s | 3.38 s | 0.04 | not run | No gain over q5_0 |
| `ggml-large-v3-turbo` | 1625 MB | 1.69 s | 3.27 s | 0.04 | not run | No gain over q5_0 |

## What I verified and what I did not

| Claim | How I know |
| --- | --- |
| Model files are complete | Observed. I re-hashed all seven files the earlier attempt left in `~/Library/Caches/online-office/whisper/` against the SHA-256 that Hugging Face publishes. All matched. |
| Latency and WER per model | Measured with scripts in `/tmp/office-research/stt/bin`. Six `say` clips, plus a noisy copy and six held-out phrases. Timings come with a caveat about machine load (see Test setup). |
| All inference used Metal | Observed. Every `whisper-cli` run and every server log shows `using MTL0 backend` on the Apple M4. The CPU-only runs show `use gpu = 0`. |
| `verbose_json` doubles latency, `audio_ctx` shrinking hurts accuracy | Measured on the same clips in the same session. |
| Server-side VAD removes non-speech hallucinations | Measured on silence, noise, thump and clicks. |
| `webkitSpeechRecognition`, `getUserMedia`, `speechSynthesis` behavior | Observed with a throwaway Electron 44.4.5 app. Logs are in `results/electron-*.log`. |
| The capture pipeline, both VADs, TTS gating | Observed in an Electron app. The microphone was Chromium's fake audio device playing WAV scenes. It needed `--no-sandbox`. |
| Real microphone audio | Not observed. The real device returned silence (section 3), so every voice test used `say` clips, not a human voice. |
| The TCC dialog, real echo cancellation, speakers into the mic | Not observed. See the not-measured list. |
| Linux and Windows | Not run. I inspected the release archives only. |
| The code sketch | Partly run. The main-process half ran against the real server. The renderer half was bundled but not run as a module. See the note under the sketch. |

**Not measured.** These are left out on purpose, and each could change a decision.

- A human voice on a real microphone, including accents and room noise.
- The macOS microphone dialog in an interactive `pnpm dev` run, and after packaging.
- What `echoCancellation: true` does to the agents' TTS leaking into the mic.
- Any Linux or Windows machine, Vulkan or CUDA builds, and Intel Macs.
- whisper.cpp 1.9.4 on macOS (upstream ships no macOS binary) and the Core ML encoder (the Homebrew build prints `COREML = 0`).
- Utterances longer than about 7 s, including the 30 s window and chunking.
- The cold `whisper-cli` timing of `medium-q5_0`, and a rerun of the full cold table on a quiet machine.
- Whether a real code-switched sentence (Portuguese with English nouns) confuses language auto-detect. My clips were one language each.
- The server's `/load` endpoint for swapping models. The string is in the binary. I did not call it.
- The whole 3D office rendering while whisper runs. Other agents' Electron apps did load the GPU during my runs, which is the closest I have.
- The renderer half of the code sketch as a running module, live captions, and the server's default beam search against the greedy setting I used (`-bs 1 -bo 2`).

## Test setup

**Clips.** Six clips of 3 to 6 s, made with `say` and converted with `ffmpeg -ar 16000 -ac 1 -c:a pcm_s16le`.

| Clip | Voice | Length | Text |
| --- | --- | --- | --- |
| en1 | Samantha | 3.22 s | Use Postgres, not SQLite, and add a README. |
| en2 | Samantha | 4.67 s | Please refactor the auth module and run the unit tests before you open a pull request. |
| en3 | Samantha | 3.37 s | Can you draw a diagram of how the billing service talks to the queue? |
| pt1 | Luciana | 3.31 s | Pode rodar os testes e depois me mostra o diagrama. |
| pt2 | Luciana | 6.23 s | Usa o Postgres em vez do SQLite e adiciona um README com as instruções de instalação. |
| pt3 | Luciana | 4.46 s | Roda o build, corrige os erros de lint e abre um pull request. |

Studio-clean synthetic voices are the easy case. I made two harder sets. The noisy set is the same six clips with pink noise at 10 dB SNR, a 300 to 3400 Hz band limit and 3 dB less gain. The held-out set is six new phrases with words the first set does not contain (Kubernetes, TypeScript, Redis, GitHub, rollback), read by Daniel, Reed and Eddy, with a noisy copy of each.

**Scoring.** WER is word edit distance after lowercasing and removing punctuation. On six clips one wrong word moves the mean by 0.02 to 0.09, so read differences under 0.05 as noise. I also read every transcript.

**Machine state.** Other agents ran Electron apps and dev servers on this Mac during my runs. The load average was 2 to 14, swap was 10.5 to 11.6 GB of 12 to 13 GB, and a 3D scene rendered on the same GPU at times. The same turbo-q5_0 encoder pass took a median 1.22 s in the earlier agent's quiet run and 2.50 s in my busy run. So the tables give medians and minimums, the cold table has two columns, and the warm table comes from a fairly calm window (load average about 3). The busy numbers are close to what the owner will see, because the office itself renders on the same GPU.

**Rerun.** Scripts and raw results live in `/tmp/office-research/stt/`, which the OS may clean up. `bin/bench_cli.py` and `bin/bench_server.py` do the timing. `bin/bench_variants.py`, `bin/bench_holdout.py`, `bin/bench_ac_fixed.py`, `bin/bench_extra.py` and `bin/bench_vad_server.py` cover accuracy and non-speech input. `electron/pipe/run.sh` runs the Electron pipeline, `electron/probe.js` the Electron probes, and `dl-test/model-download.mjs` the download test.

## 1. Models and speed

### 1.1 Warm and cold latency

The server table in the Answer is the number to plan with. The cold column shows what a one-process-per-utterance design (`whisper-cli`) costs. The times are the median wall clock over 18 runs (six clips, three repeats), forced language then auto.

| Model | Cold CLI, quiet run | Cold CLI, busy run | Server start | Server RSS |
| --- | --- | --- | --- | --- |
| `base-q5_1` | 0.56 / 0.56 s | 1.06 / 1.56 s | 0.11 s | 182 MB |
| `base` | 0.56 / 0.57 s | 1.16 / 1.57 s | 0.22 s | 298 MB |
| `small-q5_1` | 0.83 / 1.08 s | 2.07 / 3.09 s | 0.17 s | 371 MB |
| `small` | 1.08 / 1.08 s | 1.87 / 2.67 s | 0.38 s | 703 MB |
| `medium-q5_0` | not run | not run | 0.43 s | 808 MB |
| `turbo-q5_0` | 1.59 / 3.09 s | 3.37 / 4.10 s | 0.38 s | 659 MB |
| `turbo-q8_0` | 2.58 / 4.09 s | 2.08 / 3.85 s | 0.55 s | 937 MB |
| `turbo` (fp16) | 2.71 / 3.62 s | 2.08 / 4.11 s | 1.47 s | 1652 MB |

Clip length barely matters. Whisper always encodes a 30 s window, so turbo-q5_0 took 1.57 to 2.10 s across all six clips in the quiet run. The server starts in 0.11 to 1.47 s, and its first requests are slower than steady state. In the Electron pipeline the first request took 1.9 s and the next two utterances 1.7 s and 1.5 s, against 0.7 to 0.8 s for the rest (`verbose_json`, one warm-up). With four warm-up requests all six utterances took 0.72 to 0.82 s. Send three warm-up requests at start.

**The cold CLI wall clock includes a fixed exit delay.** For `base-q5_1` on en1 whisper reports 0.15 to 0.21 s of its own time, and the process takes 0.57 s. Even `whisper-cli --help` takes 0.55 s. The last stderr line appears at 0.17 s and the process ends at 0.53 s. `GGML_METAL_NO_RESIDENCY=1` removes it. Cold wall time then drops to 0.18 to 0.31 s for base-q5_1, 0.40 to 0.41 s for small-q5_1 and 1.39 to 1.42 s for turbo-q5_0. That points at the Metal residency-set teardown in ggml 0.13.0. I did not trace it further. It does not affect the resident server, and it is one more reason not to spawn a process per utterance.

### 1.2 Accuracy per clip

Language forced, `whisper-cli`, one run each. The three models below are the ones that matter. "ok" means an exact match after case and punctuation.

| Clip | `base-q5_1` | `small-q5_1` | `turbo-q5_0` |
| --- | --- | --- | --- |
| en1 | "Use PostGurse, not SQLite, and add a readme." | "Use PostGurse, not SQLite, and data readme." | "Use Postgres, not SQ Lite, and add a README." |
| en2 | "...refactor the off module... open a full request." | ok | ok |
| en3 | ok | ok | ok |
| pt1 | "...me mostra o dia grama." | ok | ok |
| pt2 | "Posa o post gris em vez do SQLite e adiciona um reá de micomas instruções..." | "Usa o postgres em vez do SQLite e adiciona um reádeme com as instruções..." | ok |
| pt3 | "Roda o buio de, corrigir os erros de linte e abre um puro recurso." | "Roda o buíode, corrige os erros de linte e abre um pulo request." | ok |

English tech nouns (Postgres, build, lint, pull request) are what small and base get wrong, in English sentences and inside Portuguese ones. Turbo gets them right on these clips. Mean WER over these clips is 0.21, 0.11 and 0.04. `whisper-cli` and the server disagree by a word or two on some clips. On these six the CLI gave 0.29 for `base` and 0.08 for `small`, and the server, which is what ships, gave 0.37 and 0.15. That is the size of noise to expect from six clips.

Under noise and on held-out phrases every model gets worse, and the ranking stays. Held-out phrases include Kubernetes, TypeScript, Redis and GitHub read with Portuguese phonetics by the pt-BR voices, so part of the error there comes from the synthetic voice and not the model. Turbo-q5_0 wrote "Jithub", "NamaSpace" and "chip script". Small-q5_1 wrote "JIT Hub" and "tipo script".

| Model | Clean | Noisy | Held-out clean | Held-out noisy |
| --- | --- | --- | --- | --- |
| `base-q5_1` | 0.21 | 0.48 | 0.39 | 0.53 |
| `small-q5_1` | 0.11 | 0.28 | 0.26 | 0.45 |
| `medium-q5_0` | 0.08 | 0.17 | 0.30 | 0.41 |
| `turbo-q5_0` | 0.04 | 0.12 | 0.23 | 0.34 |

### 1.3 Language auto-detect against a forced language

Auto-detect picked the right language on all 36 auto runs of every one of the seven models. Confidence was at least 0.999 for turbo, 0.92 for small, 0.81 for base-q5_1 and 0.66 for base. The transcripts were identical to the forced-language transcripts on every clip. The cost is time. `whisper-cli` ran the encoder once with a forced language and twice with auto-detect, in all 126 runs of each kind. So warm small-q5_1 goes from 0.33 s to 0.60 s, and warm turbo-q5_0 from 1.36 s to 2.97 s.

This is a weak test. Each clip was one language, spoken by a clean synthetic voice. A wrong guess on a real code-switched sentence gives gibberish in the wrong language, so a language setting is a safety net as well as a speed-up. Detecting with `base-q5_1` (0.15 s) and then transcribing with the language forced would cost less than auto-detect on turbo (about 1.5 s instead of 3.0 s). I did not build it.

### 1.4 Metal and CPU

Every GPU run used Metal (`using MTL0 backend`, flash attention on, Apple M4, unified memory). The table shows whisper's own total time for one 3.2 s clip, language forced.

| Model | Metal | CPU only, 4 threads | Ratio |
| --- | --- | --- | --- |
| `base-q5_1` | 0.19 s | 0.94 s | 5 times |
| `small-q5_1` | 0.35 to 0.44 s | 2.60 s | 6 to 7 times |
| `turbo-q5_0` | 1.30 to 1.52 s | 10.49 s | 7 to 8 times |

Turbo is unusable on CPU, and small is marginal. This matters for Linux and Windows (section 5).

### 1.5 What does not help

**Shrinking the encoder context.** `audio_ctx` (per request, or `-ac` on the server) cuts encoder time, but it changes the output. I ran 24 clips (clean, noisy, held-out, held-out noisy) at four context sizes on turbo-q5_0. Against the full-context transcripts, 1250 stayed identical on 10 of the 24 clips, 1000 on 6 and 750 on 8. Mean WER went from 0.183 to 0.191, 0.246 and 0.270. A context sized to the clip (seconds plus one, times 50) produced garbage on turbo (WER 0.94, "of, of" for en1) and raised small-q5_1 from 0.11 to 0.29. Leave `audio_ctx` at the default.

**`verbose_json`.** It adds an encoder pass for language probabilities (small-q5_1 0.27 s with `json`, 0.49 s with `verbose_json`, 0.32 s with `verbose_json` and `no_language_probabilities=true`). The `json` response carries only the text, so the app does not learn which language auto-detect chose. If the UI needs that, pay for the extra pass only in that case.

### 1.6 A vocabulary prompt helps small models, with limits

The server accepts a `prompt` field. A glossary that lists the words in the clip helps a lot. It took small-q5_1 from 0.111 to 0.026 on clean audio and from 0.284 to 0.133 on noisy audio, and turbo-q5_0 from 0.042 to 0.000. That test is contaminated, because the glossary contained the answers. So I ran the held-out phrases with four prompts.

| Model (held-out clean) | No prompt | Unrelated glossary | Right glossary | Generic sentence |
| --- | --- | --- | --- | --- |
| `small-q5_1` | 0.26 | 0.24 | 0.15 | 0.26 |
| `medium-q5_0` | 0.30 | 0.24 | 0.15 | 0.23 |
| `turbo-q5_0` | 0.23 | 0.24 | 0.16 | 0.20 |

An unrelated glossary and a generic sentence are neutral to mildly helpful. A glossary of the real words cuts the error by a third to a half on clean audio. Under noise it can hurt. On noisy held-out audio turbo-q5_0 went from 0.34 to 0.45 with the right glossary and to 0.51 with the generic sentence, and one clip came back as English filler ("I'm going to use the software to get the code") for Portuguese audio. Building a per-project glossary from the block folder (package names, file names, employee names) is cheap and worth an experiment. Do not make it a default without a noisy-audio check.

### 1.7 Silence and noise make whisper invent text

Sent to the server with no VAD, silence and noise did not come back empty.

| Input | `small-q5_1` | `turbo-q5_0` |
| --- | --- | --- |
| 3 s of silence | "[BLANK_AUDIO]" | "Thank you." |
| 5 s of quiet pink noise, auto | garbage ("ΧÌ Totally ʟʃ̒ iten"), after 11.8 to 12.0 s | "." |
| 0.9 s thump, auto | "" | "." |
| 1.4 s of keyboard clicks, auto | "" | "Gracias." |
| same thump, language forced to English | "(bass thumping)" | "." |

The 12 s decode blocks the server for everything queued behind it. Starting the server with `--vad -vm ggml-silero-v5.1.2.bin` (885 KB) fixed all of it. Every non-speech input returned "" in 0.00 to 0.09 s. The WER on the six speech clips did not change (0.111 and 0.042). Their median latency in that session was 0.58 s against 0.47 s on small-q5_1 and 2.09 s against 1.90 s on turbo-q5_0, so the built-in VAD may add 0.1 to 0.2 s. I did not separate that from machine noise. A post-filter that drops text wrapped in brackets or parentheses catches the tags I saw (`[BLANK_AUDIO]`, `(clicking)`, `[Music]`, `(beeping)`, `[silence]`).

## 2. Running whisper-server

The binaries and flags below are from the installed 1.8.4.

- **Files.** `brew install whisper-cpp` installs `whisper-cli`, `whisper-server`, `whisper-stream` (captures the mic through SDL, so it does not fit an Electron pipeline), `whisper-command`, `whisper-bench`, `whisper-quantize`, `whisper-lsp`, `whisper-talk-llama` and `whisper-vad-speech-segments` in `/opt/homebrew/bin`. The ggml backends load from `/opt/homebrew/Cellar/ggml/0.13.0/libexec`.
- **Flags used.** `-m` model, `-l auto`, `-t 4`, `-bs 1 -bo 2` (greedy, the fast setting I benchmarked), `--host 127.0.0.1`, `--port`, `--vad -vm <model>`. Defaults are host `127.0.0.1` and port 8080. I did not compare against the default beam search.
- **Endpoints.** `GET /` returns 200 once the model has loaded, which is the readiness check, and `GET /health` returns 200 with a small JSON body. `POST /inference` takes multipart fields `file`, `response_format`, `language`, `temperature`, `prompt`, `audio_ctx`, `vad`, `suppress_non_speech` and more. `/load` exists in the binary. I did not call it, so the model swap it offers is untested.
- **Input.** Send 16-bit PCM WAV. `--convert` accepts other formats but needs `ffmpeg`. The pipeline sends WAV, so it does not.
- **One inference at a time.** The server serializes requests. A final request sent 100 ms after an interim request started took 0.99 s instead of 0.58 s on small-q5_1 and 5.0 s instead of 2.5 s on turbo-q5_0.
- **Safety.** It answers every request with `Access-Control-Allow-Origin: *` (checked on the installed binary), so any web page in the owner's browser can post audio to it. Bind `127.0.0.1`, pick a random free port, and set `--request-path` to a random string. I did not test the request path.
- **Warm-up.** Post three 1 s silent requests with `vad=false` at start. With server VAD on, silence never reaches the encoder and would not warm anything. In the sketch the three warm-ups took about 1 s of a 1.34 s start, so they did reach the encoder.
- **Stopping.** I saw no flag that ties the server to its parent, and I did not test a parent crash. Kill it on `before-quit`, and write a pidfile so the next launch can kill a leftover.

## 3. Speech and microphone inside Electron

All of this comes from a throwaway app in `/tmp/office-research/stt/electron` on Electron 44.4.5, launched with `electron .` from a terminal session. If your shell has `ELECTRON_RUN_AS_NODE=1` (mine did, inherited from the host app), Electron runs as plain Node and fails with `Cannot read properties of undefined (reading 'whenReady')`. Unset it first.

### 3.1 webkitSpeechRecognition

`typeof webkitSpeechRecognition` is `function`, and `start()` returns without throwing. Then it fails.

```
102 ms  start
399 ms  audiostart
783 ms  audioend
783 ms  error   error="network" message=""
784 ms  end
```

Chromium also logs `services/network/chunked_data_pipe_upload_data_stream.cc:220 OnSizeReceived failed with Error: -2`. The failure is at the upload to Google's speech service. I did not test with an API key. Do not build on it.

### 3.2 getUserMedia and the microphone permission

Three setups, each run with `getUserMedia({audio:true})` and again with echo cancellation, noise suppression and auto gain off.

| Setup | `permissions.query` | `enumerateDevices` labels | `getUserMedia` | Samples in 1 s |
| --- | --- | --- | --- | --- |
| No permission handlers | granted | visible | resolved in 479 ms | 20480 of 20480 exactly zero |
| Both handlers return `true` | granted | visible | resolved in 415 ms | 20480 of 20480 exactly zero |
| Both handlers return `false` | denied | "(no label)" | rejected, `NotAllowedError` "Permission denied", after 191 ms | none |

The track was "Default - MacBook Air Microphone (Built-in)". Its settings were `sampleRate: 48000`, `channelCount: 1`, and `echoCancellation`, `noiseSuppression` and `autoGainControl` all `true` by default. `enumerateDevices` also listed an iPhone microphone and a Bluetooth headset.

**Permission handler.** Dev mode needs none, because Electron approves media requests when no handler is set. If the app installs one, it must allow `media` in both `setPermissionRequestHandler` and `setPermissionCheckHandler`. With handlers set to allow, Electron called the check handler with `media` and `mediaType` `audio` or `video` (during `enumerateDevices` too), and called the request handler with `media` and `mediaTypes: ['audio']`. Allow audio for the app's own origin and deny video and everything else.

**macOS entitlement and Info.plist.** The dev `Electron.app` already contains `NSMicrophoneUsageDescription` ("This app needs access to the microphone"), `NSCameraUsageDescription` and `NSAudioCaptureUsageDescription`. It is ad-hoc signed without the hardened runtime and with no entitlements. So dev mode needs no entitlement, and what decides access is TCC. A packaged, hardened-runtime build needs both. Slack and Wispr Flow (Electron, hardened runtime) carry `com.apple.security.device.audio-input` and a `NSMicrophoneUsageDescription` string. I read both with `codesign -d --entitlements -`. Slack carries the key on the main app and on `Slack Helper.app`. Wispr Flow carries it on the main app and on two helpers. So in electron-builder set `mac.hardenedRuntime`, put the audio-input key in both `entitlements` and `entitlementsInherit`, and add `mac.extendInfo.NSMicrophoneUsageDescription`. I checked those option names in electron-builder's `macOptions.ts` and did not build a package.

**What I could not observe.** The status was `not-determined` before and after every run. `askForMediaAccess('microphone')` returned `false` after 21 ms and the status stayed `not-determined`, with no dialog. The captured samples were all zero. I read this as macOS delivering silence because access was never granted, and I could not tell from a headless session whether an interactive `pnpm dev` run would show a dialog or which name it would carry (Electron or the terminal app). I did not launch through `open` and click Allow, because that would change the owner's privacy grants. Electron's docs say the prompt shows once, and after a denial the owner has to change it in System Settings and restart the app.

What the implementer should do:

1. On startup call `systemPreferences.getMediaAccessStatus('microphone')`.
2. If it is `not-determined`, call `await systemPreferences.askForMediaAccess('microphone')` before opening the stream.
3. If it is `denied` or `restricted`, show a message with a button that opens `x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone`.
4. After `getUserMedia`, read the first second from the worklet. If every sample is exactly zero, treat the mic as blocked. A live mic always has some noise.

### 3.3 speechSynthesis

`speechSynthesis` is present. `getVoices()` returns 0 voices immediately, `voiceschanged` fires 312 ms later with 180 voices, and it fires again at 1.6 s. There are 28 en-US voices and 9 pt-BR voices: Eddy, Flo, Grandma, Grandpa, Luciana, Reed, Rocko, Sandy and Shelley (most carry a "(Portuguese (Brazil))" suffix in the name, Luciana does not). `speak()` with Samantha called `onstart` 76 ms later, fired `boundary` events per word and called `onend` after 2.3 s. The pt-BR Luciana utterance started after 8 ms and ended after 2.5 s. These events are the hook for the echo gate in section 4. I could not hear the output, so I did not verify that sound came out.

## 4. Capture pipeline

### 4.1 Capture

Use an AudioWorklet. Open the stream with `getUserMedia`, create `new AudioContext({ sampleRate: 16000 })` (Chromium resamples the 48 kHz device), and tap it with a worklet that emits 512-sample Int16 blocks (32 ms) plus an RMS level for a meter. Blocks go into a ring. Whisper wants exactly this format, so there is no decode step.

`MediaRecorder` also works for push-to-talk, and I measured it against the worklet on six utterances. It supports `audio/webm;codecs=opus` and `audio/mp4`, and not `audio/ogg` or `audio/wav`. Opus came out at 128 kbit/s, 53 to 105 KB against 113 to 208 KB of PCM. `stop()` to `dataavailable` took 0 to 2 ms and `decodeAudioData` took 7 to 29 ms. Transcripts were identical on five of six clips. Two things rule it out. It cannot pre-roll, so the first utterance came back 0.27 s short (3.36 s against 3.63 s). And it has no continuous buffer to cut utterances from, which proximity mode needs. One capture path for both modes is simpler.

The tests ran in a hidden window (`show: false`) with `backgroundThrottling: false`, and the worklet kept running. Opening the mic costs 0.2 to 0.5 s (`getUserMedia` 237 to 479 ms), so keep it open while the owner is near an employee. Close it when nobody is near, which also turns off the macOS mic indicator.

### 4.2 Sending audio to main

Send the PCM bytes with `ipcRenderer.invoke`. It structured-clones the array, which is cheap at this size. The round trip for a Uint8Array of 94 KB (3 s), 313 KB (10 s) and 938 KB (30 s) took a median 0.10, 0.20 and 0.40 to 0.50 ms. `invoke` has no transfer list. A transfer array passed as an extra argument is cloned as data, and the sender's buffer stays intact. A `MessageChannelMain` port took 0.30 ms for 938 KB by copy, but posting with an `ArrayBuffer` transfer list arrived in main as `null` and no reply came. Electron's docs say only `MessagePort` objects can be transferred. So plain `invoke` is the right choice. The main process wraps the bytes in a 44-byte WAV header and posts them to the server. The renderer's `slice()` and the VAD path each allocate a buffer that holds only the utterance, so the clone copies only the audio.

### 4.3 Voice activity detection for proximity mode

Push-to-talk needs no VAD, because the key press and release are the boundaries. Proximity mode needs one. I ran an energy VAD (adaptive floor, start at 12 dB above it for 96 ms, end after 600 ms below 8 dB above it) and Silero v5 through `@ricky0123/vad-web` (thresholds 0.5 and 0.35, 600 ms redemption, 300 ms pre-speech pad) on two 24 to 30 s scenes.

| Scene | Energy VAD | Silero VAD |
| --- | --- | --- |
| Speech near, 5 keyboard clicks, a door thump, far speech at -24 dB | 3 of 3 speech regions, 1 false segment (thump, whisper returned "") | 3 of 3, 0 false |
| Chord music, vacuum-like noise, alarm beeps, then two speech regions | 2 of 2, 3 false segments (whisper wrote "[Music]", "" and "(beeping)") | 2 of 2, 0 false |
| Speech start delay | 0.00 to 0.02 s | 0.03 to 0.13 s near, 0.27 s for the far talker |
| Decision delay after the last word | 0.54 to 0.64 s | 0.61 to 0.74 s |
| Renderer CPU while listening | 3.6% of one core | 9.3% of one core |
| Assets | none | 16.6 MB |

**Recommendation.** Use Silero in the renderer for the utterance boundaries, and `--vad` in the server as a second net. The energy VAD fires on any loud sustained sound, and each false trigger costs a whisper decode that delays the real utterance. That is about 0.5 s on small, 2.5 s on turbo, and 12 s for five seconds of noise in auto mode. Silero costs about 6% of a core more while listening, 16.6 MB of assets and 0.03 to 0.27 s of extra start delay, which the 300 ms pre-speech pad covers. Both VADs would also fire on a colleague talking or a video call. Nothing here separates the owner from other speakers. Proximity mode needs a plan for that, such as a wake word or requiring the owner to face the employee.

The renderer loaded exactly these files from the asset base: `silero_vad_v5.onnx` (2,327,524 bytes), `ort-wasm-simd-threaded.wasm` (14,239,897 bytes), `ort-wasm-simd-threaded.mjs` (24,381 bytes) and `vad.worklet.bundle.min.js` (2,480 bytes), plus our own worklet file. The vad-web package fetches them, and `fetch` does not work on `file://`, so serve them through a custom protocol (`protocol.handle('app', ...)` with `registerSchemesAsPrivileged`, as the test did). Set `ort.env.wasm.numThreads = 1` so it does not need cross-origin isolation. The `ortConfig` option exists in vad-web 0.0.31 at runtime but not in its `.d.ts`, so the object literal needs a cast under `tsc`.

### 4.4 Interim results

Do not show interim text by default. whisper-server has no streaming mode. The only way to get partial text is to re-decode the growing buffer, which costs a full request each time (0.45 to 0.58 s on small-q5_1 for 1.5 to 6 s of audio, 2.3 to 2.5 s on turbo). The partial text also rewrites itself. For pt2 turbo produced "Usa o poste grisei e veja" at 1.5 s and "Usa o Postgres em vez do SQLite..." at the end. And because the server runs one request at a time, a partial in flight delays the final text (measured above). Show the mic level, a "Listening" state from the VAD, and a "Transcribing" state after release. The final text arrives 0.3 to 0.6 s later. If live captions are wanted later, they are feasible for small only, sent every 1 to 1.5 s while V is held, and never while a final is pending.

### 4.5 Not transcribing the agents' own voices

I built a scene with the owner speaking three times and an agent's TTS speaking twice (one English, one Portuguese). The TTS leaks into the mic 14 dB below speech, band-limited to 250 to 3800 Hz with a 45 ms reflection.

| Gate | Energy VAD | Silero VAD |
| --- | --- | --- |
| Off | 3 of 3 owner utterances, and both TTS lines transcribed as phantom owner speech | 3 of 3 owner utterances, and both TTS lines transcribed as phantom owner speech |
| On | 3 of 3, 0 phantom | 3 of 3, 0 phantom |

The phantom text was "Done. I switched the database to posters and added the read..." and "Terminei. Adicionei um Readme e rodeio testes. Tudo passou." So an agent's spoken answer would go straight back to it as the owner's next instruction. The gate closed at 0.15 s before the TTS text and reopened 0.45 s after it ended. In the app those times come from `utterance.onstart` and `onend`.

**Recommendation.** Half duplex. While TTS plays, pause the VAD and drop anything it emits. Keep dropping for 400 ms after `onend`, because room reverb lingers and the VAD's own redemption window would otherwise end a segment just after the gate opens. Push-to-talk is the barge-in. Pressing V calls `speechSynthesis.cancel()`, records, and the owner can interrupt an agent that way. A user mid-sentence when TTS starts loses that utterance, and I accept it.

**Echo cancellation.** `getUserMedia` reports `echoCancellation: true` by default, and I turned it off in the pipeline test, so I have no measurement of what it does to this leak. Cancelling needs the far-end signal, and Chromium takes it from audio it plays itself. Whether macOS speech synthesis output counts is untested. Leave it off, because it can also attenuate the owner's voice during double talk, and rely on the gate. If the app later plays TTS through Web Audio, try `echoCancellation: true` with a real speaker test. Headphones remove the problem, and a setting could skip the gate when it detects them.

## 5. Shipping it

### 5.1 Find the binary

`findBinary` in the sketch checks `PATH`, then `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin` and `~/.local/bin`, then asks the login shell with `$SHELL -ilc 'command -v <name>'`. With `PATH=/usr/bin:/bin:/usr/sbin:/sbin` it found `/opt/homebrew/bin/whisper-server` immediately. A missing binary took 0.96 s through the login-shell fallback, so run it once at startup, not per call. If nothing is found, show a first-run panel with `brew install whisper-cpp` and a button to check again. Upstream ships no macOS binary (only an xcframework), and the Homebrew binary depends on Homebrew's ggml libraries, so copying it into the app is not an option. Bundling a static build of our own is a separate job.

### 5.2 Download the model on first use

Models come from `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/<name>` into `~/Library/Caches/online-office/whisper/`, the same folder this research used, so the real app finds the files already there. The 302 response from Hugging Face carries `x-linked-size` and `x-linked-etag`, and the etag is the file's SHA-256. One `HEAD` with `redirect: 'manual'` gives the size, the hash and the CDN URL. The sketch streams to `<name>.part`, resumes with a `Range` header, reports progress, verifies the hash and renames.

I ran it on `ggml-base-q5_1.bin` (59.7 MB). It stopped after 20 MB, resumed with an HTTP 206 from the byte where it stopped, finished, matched the published SHA-256 (the module checks it before the rename, and I hashed the file again by hand), and a third call returned at once because the file was complete. I ran it twice, as a plain script with a test hook that drops the connection (resumed from byte 20,008,574 in 45 s) and as the TypeScript module below with an `AbortController` (47.8 s). The connection ran at about 0.9 MB/s during those tests and at about 6 MB/s when the earlier attempt fetched the 1.6 GB file, so expect 30 s to 3.5 min for `small-q5_1`. Also download `ggml-silero-v5.1.2.bin` (885,098 bytes, SHA-256 `29940d98...ea2cf`) from `https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin`.

### 5.3 Linux and Windows

The path is the same server, from the upstream release. The tag `v1.9.4` has no files attached. The build tag `b5130` (published 2026-09-11, the same day) has the binaries. I downloaded three of them (Linux x64, Linux arm64, Windows x64), matched their SHA-256 digests to the GitHub API, and read the archive listings. I did not run them, because I have no Linux or Windows host and the Docker daemon was not running.

| Platform | Asset | Size | Contents and limits |
| --- | --- | --- | --- |
| Linux x64 | `whisper-bin-ubuntu-x64.tar.gz` | 9.8 MB | `whisper-cli`, `whisper-server`, `libwhisper.so`, `libggml*.so` and one `libggml-cpu-<arch>.so` per CPU generation (sse42 to sapphirerapids, zen4). ELF with `$ORIGIN` rpath, so keep the files together. It needs `libstdc++` and `libc`. CPU only. |
| Linux arm64 | `whisper-bin-ubuntu-arm64.tar.gz` | 4.6 MB | CPU only. |
| Windows x64 | `whisper-bin-x64.zip` | 8.6 MB | `whisper-cli.exe`, `whisper-server.exe`, `whisper.dll`, `ggml*.dll` with CPU variants. CPU only. |
| Windows x64, NVIDIA | `whisper-cublas-12.4.0-bin-x64.zip`, `whisper-cublas-11.8.0-bin-x64.zip` | 675 MB, 273 MB | CUDA build. Needs an NVIDIA driver. |
| Windows x64, other | `whisper-blas-bin-x64.zip` | 21 MB | OpenBLAS CPU build. |
| Windows arm64 | `whisper-bin-win-cpu-arm64.zip`, `whisper-bin-win-cuda-13.4-arm64.zip` | 4.4 MB, 289 MB | CPU, or CUDA. |

There is no prebuilt Vulkan or CUDA build for Linux in that list, so GPU on Linux means building whisper.cpp from source. For the app, download the right archive on first use with the same code as the model (the GitHub API returns a `digest` for each asset), unpack it into the cache folder, and run `whisper-server` from there.

**Model choice without a GPU.** On this M4 CPU alone (4 threads) small-q5_1 took 2.6 s and turbo-q5_0 took 10.5 s for a 3.2 s clip, because the encoder always processes a 30 s window. A typical x86 laptop will not be faster. So on CPU-only machines default to `base-q5_1` (0.94 s here), and offer `small-q5_1` only if a first-run test says it is fast enough. That test transcribes a bundled 3 s clip and steps down a model when the time is over 1 s. Turbo is out on CPU.

Electron's `getUserMedia`, `AudioWorklet` and `speechSynthesis` are Chromium features, so the pipeline code should carry over. I did not run any of it off macOS, and the microphone permission story is different on each system.

## 6. Code sketch

Four files, in the order data moves. A worklet feeds a renderer module. The module hands utterances to the app, which sends them to main over IPC. Main posts them to the server. The shapes are `Utterance = { source, pcm: Int16Array }` in the renderer and `Uint8Array` bytes over IPC.

`pcm-worklet.js` runs on the audio thread and is served from the asset base.

```js
class Pcm extends AudioWorkletProcessor {
	constructor() {
		super()
		this.buf = new Float32Array(512)
		this.n = 0
	}
	process(inputs) {
		const ch = inputs[0][0]
		if (!ch) return true
		for (let i = 0; i < ch.length; i++) {
			this.buf[this.n++] = ch[i]
			if (this.n < 512) continue
			const pcm = new Int16Array(512)
			let sq = 0
			for (let k = 0; k < 512; k++) {
				const v = Math.max(-1, Math.min(1, this.buf[k]))
				pcm[k] = v < 0 ? v * 0x8000 : v * 0x7fff
				sq += v * v
			}
			this.port.postMessage({ pcm, rmsDb: 10 * Math.log10(sq / 512 + 1e-12) }, [pcm.buffer])
			this.n = 0
		}
		return true
	}
}
registerProcessor('pcm', Pcm)
```

`voice.ts` runs in the renderer. It owns the ring buffer, push-to-talk, Silero and the echo gate.

```ts
import { MicVAD } from '@ricky0123/vad-web'

export const SAMPLE_RATE = 16_000
const KEEP_SECONDS = 60
const PTT_PRE_ROLL_S = 0.2
const TTS_TAIL_MS = 400

export type Utterance = { source: 'ptt' | 'proximity'; pcm: Int16Array }

export type VoiceOptions = {
	/** URL prefix that serves pcm-worklet.js, silero_vad_v5.onnx, vad.worklet.bundle.min.js and the ort-wasm files. */
	assetBase: string
	onUtterance: (u: Utterance) => void
	/** 32 ms level readings for a mic meter. */
	onLevel?: (rmsDb: number) => void
}

export async function startVoice({ assetBase, onUtterance, onLevel }: VoiceOptions) {
	const stream = await navigator.mediaDevices.getUserMedia({
		audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
	})
	const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
	await ctx.audioWorklet.addModule(`${assetBase}/pcm-worklet.js`)

	// Ring of the last 60 s. `written` is the absolute sample count, so a slice is two indexes.
	const ring = new Int16Array(SAMPLE_RATE * KEEP_SECONDS)
	let written = 0
	const tap = new AudioWorkletNode(ctx, 'pcm', { numberOfInputs: 1, numberOfOutputs: 0 })
	tap.port.onmessage = ({ data }: MessageEvent<{ pcm: Int16Array; rmsDb: number }>) => {
		for (let i = 0; i < data.pcm.length; i++) ring[(written + i) % ring.length] = data.pcm[i]
		written += data.pcm.length
		onLevel?.(data.rmsDb)
	}
	ctx.createMediaStreamSource(stream).connect(tap)
	const slice = (from: number, to: number) => {
		const out = new Int16Array(Math.max(0, to - from))
		for (let i = 0; i < out.length; i++) out[i] = ring[(from + i) % ring.length]
		return out
	}

	let proximity = false
	let ttsPlaying = false
	let ttsTail: ReturnType<typeof setTimeout> | undefined
	const vad = await MicVAD.new({
		model: 'v5',
		audioContext: ctx,
		getStream: async () => stream, // share our stream, and never let vad-web stop its tracks
		pauseStream: async () => {},
		resumeStream: async () => stream,
		baseAssetPath: `${assetBase}/`,
		onnxWASMBasePath: `${assetBase}/`,
		ortConfig: (ort) => { ort.env.wasm.numThreads = 1 },
		startOnLoad: false,
		positiveSpeechThreshold: 0.5,
		negativeSpeechThreshold: 0.35,
		redemptionMs: 600,
		preSpeechPadMs: 300,
		minSpeechMs: 250,
		onSpeechEnd: (f32) => {
			if (ttsPlaying) return
			const pcm = new Int16Array(f32.length)
			for (let i = 0; i < f32.length; i++) pcm[i] = Math.max(-1, Math.min(1, f32[i])) * 0x7fff
			onUtterance({ source: 'proximity', pcm })
		},
	})

	const listen = () => { if (proximity && !ttsPlaying) void vad.start() }
	let pressedAt = -1
	return {
		pttPress() {
			void vad.pause()
			pressedAt = written - Math.round(PTT_PRE_ROLL_S * SAMPLE_RATE)
		},
		pttRelease() {
			if (pressedAt < 0) return
			onUtterance({ source: 'ptt', pcm: slice(Math.max(0, pressedAt, written - ring.length), written) })
			pressedAt = -1
			listen()
		},
		/** The owner is within 1.5 m of an employee. */
		setProximity(on: boolean) { proximity = on; if (on) listen(); else void vad.pause() },
		/** Call from utterance.onstart (true) and onend or onerror (false). Half duplex, so nothing is heard while the agent talks. */
		setTtsPlaying(on: boolean) {
			clearTimeout(ttsTail)
			if (on) { void vad.pause(); ttsPlaying = true; return }
			ttsTail = setTimeout(() => { ttsPlaying = false; listen() }, TTS_TAIL_MS)
		},
		close() { void vad.destroy(); stream.getTracks().forEach((t) => t.stop()); void ctx.close() },
	}
}
```

`stt-main.ts` runs in the main process. It finds the binary, starts and warms the server, and turns bytes into text.

```ts
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { delimiter, join } from 'node:path'

export type Language = 'auto' | 'en' | 'pt'
export type SttServer = { port: number; transcribe(pcm: Uint8Array, language: Language): Promise<string>; stop(): void }

/** A Dock or Finder launch gives PATH=/usr/bin:/bin:/usr/sbin:/sbin, so PATH alone misses Homebrew. */
export function findBinary(name: string): string | null {
	const exe = process.platform === 'win32' ? `${name}.exe` : name
	const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', join(process.env.HOME ?? '', '.local/bin')]
	for (const dir of [...(process.env.PATH ?? '').split(delimiter), ...extra]) {
		const candidate = join(dir, exe)
		if (existsSync(candidate)) return candidate
	}
	if (process.platform === 'win32') return null
	const shell = process.env.SHELL ?? '/bin/zsh'
	const found = spawnSync(shell, ['-ilc', `command -v ${name}`], { encoding: 'utf8', timeout: 3000 }).stdout.trim().split('\n').pop() ?? ''
	return found.startsWith('/') && existsSync(found) ? found : null
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer()
		probe.once('error', reject)
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address() as { port: number }
			probe.close(() => resolve(port))
		})
	})
}

function wav16k(pcm: Uint8Array): Buffer {
	const h = Buffer.alloc(44)
	h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.byteLength, 4); h.write('WAVEfmt ', 8)
	h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
	h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
	h.write('data', 36); h.writeUInt32LE(pcm.byteLength, 40)
	return Buffer.concat([h, pcm])
}

/** whisper prints tags such as [BLANK_AUDIO], (clicking) or [Music] for non-speech, and wraps lines with newlines. */
function clean(text: string): string {
	const t = text.replace(/\s+/g, ' ').trim()
	return /^[[(].*[\])]$/.test(t) ? '' : t
}

export async function startSttServer(o: { binary: string; model: string; vadModel?: string }): Promise<SttServer> {
	const port = await freePort()
	const args = ['-m', o.model, '-l', 'auto', '-t', '4', '-bs', '1', '-bo', '2', '--host', '127.0.0.1', '--port', String(port)]
	if (o.vadModel) args.push('--vad', '-vm', o.vadModel)
	const child: ChildProcess = spawn(o.binary, args, { stdio: 'ignore' })
	const url = `http://127.0.0.1:${port}`
	for (;;) {
		if (child.exitCode !== null) throw new Error(`whisper-server exited with ${child.exitCode}`)
		try { if ((await fetch(`${url}/`)).ok) break } catch { await new Promise((r) => setTimeout(r, 30)) }
	}
	const post = async (pcm: Uint8Array, language: Language, extra: Record<string, string> = {}) => {
		const body = new FormData()
		body.set('file', new Blob([wav16k(pcm)], { type: 'audio/wav' }), 'utterance.wav')
		body.set('response_format', 'json'); body.set('temperature', '0.0'); body.set('language', language)
		for (const [k, v] of Object.entries(extra)) body.set(k, v)
		const res = await fetch(`${url}/inference`, { method: 'POST', body })
		if (!res.ok) throw new Error(`whisper-server ${res.status}`)
		return clean(((await res.json()) as { text: string }).text)
	}
	// The first requests are 2 to 3 times slower. Server-side VAD would skip silence, so switch it off for these.
	for (let i = 0; i < 3; i++) await post(new Uint8Array(64_000), 'en', { vad: 'false' })
	return { port, transcribe: (pcm, language) => post(pcm, language), stop: () => void child.kill('SIGTERM') }
}
```

`model-download.ts` runs in the main process on first use.

```ts
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebStream } from 'node:stream/web'

const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

export type Progress = { done: number; total: number; fraction: number }

async function sha256(path: string): Promise<string> {
	const hash = createHash('sha256')
	await pipeline(createReadStream(path), hash)
	return hash.digest('hex')
}

/** Downloads `name` into `dir` once. Safe to call again after a crash, a cancel or a network drop. */
export async function ensureModel(o: { name: string; dir: string; onProgress?: (p: Progress) => void; signal?: AbortSignal }): Promise<string> {
	mkdirSync(o.dir, { recursive: true })
	const dest = join(o.dir, o.name)
	// The 302 from huggingface.co carries the size and the sha256 of the file. The CDN response does not.
	const head = await fetch(`${HF}/${o.name}`, { method: 'HEAD', redirect: 'manual', signal: o.signal })
	const size = Number(head.headers.get('x-linked-size'))
	const sha = head.headers.get('x-linked-etag')?.replaceAll('"', '')
	const url = head.headers.get('location')
	if (!size || !sha || !url) throw new Error(`Hugging Face did not describe ${o.name} (HTTP ${head.status})`)
	if (existsSync(dest) && statSync(dest).size === size) return dest

	const part = `${dest}.part`
	const have = existsSync(part) ? statSync(part).size : 0
	const res = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal: o.signal })
	if (res.status !== (have ? 206 : 200) || !res.body) throw new Error(`unexpected HTTP ${res.status} (resuming from ${have} bytes)`)
	let done = have
	const body = Readable.fromWeb(res.body as WebStream)
	body.on('data', (chunk: Buffer) => { done += chunk.length; o.onProgress?.({ done, total: size, fraction: done / size }) })
	await pipeline(body, createWriteStream(part, { flags: have ? 'a' : 'w' }))
	if ((await sha256(part)) !== sha) { unlinkSync(part); throw new Error('sha256 mismatch, partial file deleted') }
	renameSync(part, dest)
	return dest
}
```

Wiring, in the preload and the renderer. Push the `progress` events to the UI over IPC from `onProgress`.

```ts
// preload: bytes cross IPC as a Uint8Array view of the Int16 samples
contextBridge.exposeInMainWorld('stt', {
	transcribe: (pcm: Int16Array, language: Language) =>
		ipcRenderer.invoke('stt:transcribe', { pcm: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), language }),
})
// main
ipcMain.handle('stt:transcribe', (_e, { pcm, language }) => server.transcribe(pcm, language))
// renderer
const voice = await startVoice({ assetBase: 'app://voice', onUtterance: async (u) => sendToNearestEmployee(await window.stt.transcribe(u.pcm, language)) })
window.addEventListener('keydown', (e) => { if (e.code === 'KeyV' && !e.repeat) voice.pttPress() })
window.addEventListener('keyup', (e) => { if (e.code === 'KeyV') voice.pttRelease() })
```

**What ran.** `stt-main.ts` was bundled with esbuild and run in Node against the real server with `small-q5_1` and the Silero VAD model. The server was ready and warmed in 1.34 s. The transcripts took 0.66 s for en1 with auto-detect, 0.66 s for pt1 with auto-detect and 0.38 s for pt1 with `pt`. Five seconds of noise and 1.4 s of clicks came back as "" in 11 and 10 ms. `findBinary` found the Homebrew binary under a Dock-style `PATH`. `model-download.ts` was bundled and run against Hugging Face (cancel at 20 MB, resume, verify, repeat call), and section 5.2 has the result. `voice.ts` was bundled with esbuild (it pulls in vad-web and onnxruntime-web) but not run as a module. The logic in it ran in `electron/pipe/pipe.js` on the fake microphone. That is the same worklet, the same Silero options, `pause` and `start` for the gate, and a ring slice for push-to-talk. Expect small integration bugs in the renderer half, above all the vad-web start and pause interplay and the asset protocol.

## Open risks

- **Accuracy on real speech.** Everything here used synthetic voices. Small-q5_1 already fails on English nouns inside Portuguese. A human with an accent and a fan running will be worse, and the noisy set shows the direction (0.11 to 0.28 WER for small, 0.04 to 0.12 for turbo). Plan a real-voice check as the first act of the voice unit, and keep the turbo option ready.
- **Latency under GPU load.** The 3D office and whisper share the GPU. Busy-machine runs took up to twice as long as quiet ones (the same turbo-q5_0 encoder pass took 1.22 s, then 2.50 s). Twice the quiet numbers would be about 0.7 s for small-q5_1 and 2.7 s for turbo-q5_0 with the language set. That is a projection. Measure with the real scene running.
- **The microphone dialog.** Until someone runs the app interactively, the dev-mode permission flow is unconfirmed. The zero-samples check in section 3.2 protects against a silent failure.
- **Proximity picks up other people.** See section 4.3.
- **Long holds.** The ring keeps 60 s, and whisper works in 30 s windows. Utterances over 7 s were not tested. Cap push-to-talk at a length you have tested, or chunk it.
