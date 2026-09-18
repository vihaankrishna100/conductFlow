import { env, pipeline } from "@huggingface/transformers";

declare const MEETING_ASSISTANT_URL: string;
declare const MEETING_ASSISTANT_SECRET: string;

const MODEL_ID = "Xenova/whisper-tiny.en";
const TARGET_SAMPLE_RATE = 16_000;
// Multi-threaded WASM (see numThreads below) transcribes an 8-second chunk well within
// 8 seconds, so shortening the window from the original 15s gets words on screen roughly
// twice as fast without the queue falling behind.
const CHUNK_SECONDS = 8;
const MINIMUM_FINAL_CHUNK_SECONDS = 1;
const MAX_TRACKED_SUGGESTIONS = 20;

// MV3 forbids remotely hosted executable code. The build copies ONNX Runtime's
// WASM binaries and factory modules into the extension and points the backend at them.
env.allowRemoteModels = true;
env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("wasm/");
// Extension pages (chrome-extension:// origins) are cross-origin isolated by default, so
// SharedArrayBuffer and multi-threaded WASM are available here without extra headers. Pinning
// this to 1 thread made whisper-tiny's per-chunk inference slower than the chunk window it
// transcribes, so the transcript queue fell further behind the longer capture ran.
env.backends.onnx.wasm.numThreads = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated
  ? Math.min(4, navigator.hardwareConcurrency || 4)
  : 1;

type Transcriber = Awaited<ReturnType<typeof pipeline>>;

let transcriberPromise: Promise<Transcriber> | null = null;
let stream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let processorNode: ScriptProcessorNode | null = null;
let silentGainNode: GainNode | null = null;
let inputBuffers: Float32Array[] = [];
let bufferedSampleCount = 0;
let inputSampleRate = 0;
let workChain: Promise<void> = Promise.resolve();
let stoppingPromise: Promise<void> | null = null;
let captureGeneration = 0;
let previousSuggestions: string[] = [];

function sendToBackground(message: object): void {
  void chrome.runtime.sendMessage({ target: "background", ...message }).catch(() => {
    // The service worker can restart; the next message will wake it again.
  });
}

async function requestAssistantSuggestions(recentTranscript: string, generation: number): Promise<void> {
  try {
    const response = await fetch(MEETING_ASSISTANT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-assistant-secret": MEETING_ASSISTANT_SECRET,
      },
      body: JSON.stringify({ recentTranscript, previousSuggestions }),
    });
    if (!response.ok) throw new Error(`Meeting assistant returned HTTP ${response.status}.`);

    const payload = await response.json() as unknown;
    if (!payload || typeof payload !== "object" || !("suggestions" in payload)
      || !Array.isArray(payload.suggestions)) {
      throw new Error("Meeting assistant returned an invalid response.");
    }
    if (generation !== captureGeneration) return;

    for (const value of payload.suggestions) {
      if (typeof value !== "string") continue;
      const suggestion = value.trim();
      if (!suggestion || previousSuggestions.includes(suggestion)) continue;
      previousSuggestions.push(suggestion);
      previousSuggestions = previousSuggestions.slice(-MAX_TRACKED_SUGGESTIONS);
      sendToBackground({ type: "ASSISTANT_SUGGESTION", text: suggestion });
    }
  } catch (error) {
    console.warn("Meeting assistant suggestion request failed:", error);
  }
}

function modelProgress(update: Record<string, unknown>): void {
  if (update.status === "progress" && typeof update.progress === "number") {
    sendToBackground({
      type: "MODEL_PROGRESS",
      progress: update.progress,
      message: "Downloading the local Whisper model (first use only)…",
    });
  } else if (update.status === "initiate") {
    sendToBackground({ type: "MODEL_PROGRESS", message: "Loading the local Whisper model…" });
  }
}

function getTranscriber(): Promise<Transcriber> {
  if (!transcriberPromise) {
    transcriberPromise = pipeline("automatic-speech-recognition", MODEL_ID, {
      device: "wasm",
      dtype: "q8",
      progress_callback: modelProgress,
      // The onnxruntime-web dev build @huggingface/transformers pins has a QDQ-to-MatMulNBits
      // fusion bug that fails session creation for this model's quantized embed_tokens weight
      // ("Missing required scale: ...embed_tokens.weight_merged_0_scale"). That fusion only
      // runs at optimization level "all"; "basic" keeps normal perf optimizations without it.
      session_options: { graphOptimizationLevel: "basic" },
    }).then((instance) => {
      sendToBackground({ type: "MODEL_READY" });
      return instance;
    }).catch((error) => {
      transcriberPromise = null;
      throw error;
    });
  }
  return transcriberPromise;
}

function takeSamples(count: number): Float32Array {
  const result = new Float32Array(count);
  let resultOffset = 0;

  while (resultOffset < count) {
    const first = inputBuffers[0];
    const needed = count - resultOffset;
    const copied = Math.min(first.length, needed);
    result.set(first.subarray(0, copied), resultOffset);
    resultOffset += copied;

    if (copied === first.length) {
      inputBuffers.shift();
    } else {
      inputBuffers[0] = first.slice(copied);
    }
  }

  bufferedSampleCount -= count;
  return result;
}

async function resample(input: Float32Array, sourceRate: number): Promise<Float32Array> {
  if (sourceRate === TARGET_SAMPLE_RATE) return input;

  const outputLength = Math.ceil(input.length * TARGET_SAMPLE_RATE / sourceRate);
  const context = new OfflineAudioContext(1, outputLength, TARGET_SAMPLE_RATE);
  const buffer = context.createBuffer(1, input.length, sourceRate);
  buffer.copyToChannel(input, 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  const rendered = await context.startRendering();
  return new Float32Array(rendered.getChannelData(0));
}

// Whisper was not trained to recognize silence as "nothing said" — fed a near-silent chunk
// (paused/muted tab, dead air), it commonly hallucinates, most often as one token repeated for
// the whole chunk ("so so so so…"). Skipping transcription for chunks below this energy floor
// avoids that outright, rather than trying to clean up the hallucinated text afterward.
const SILENCE_RMS_THRESHOLD = 0.005;

function rootMeanSquare(samples: Float32Array): number {
  let sumOfSquares = 0;
  for (const sample of samples) sumOfSquares += sample * sample;
  return Math.sqrt(sumOfSquares / samples.length);
}

function enqueueChunk(samples: Float32Array, sourceRate: number, generation: number): void {
  if (rootMeanSquare(samples) < SILENCE_RMS_THRESHOLD) return;

  workChain = workChain.then(async () => {
    const audio = await resample(samples, sourceRate);
    const transcriber = await getTranscriber();
    // no_repeat_ngram_size/repetition_penalty are a second line of defense: quiet background
    // noise that clears the silence gate above but still has little real speech can otherwise
    // trigger the same repeated-token degeneration.
    const result = await transcriber(audio,
      { return_timestamps: false, no_repeat_ngram_size: 3, repetition_penalty: 1.3 });
    if (generation !== captureGeneration) return;

    const text = Array.isArray(result)
      ? result.map((entry) => ("text" in entry ? String(entry.text) : "")).join(" ")
      : String((result as { text?: string }).text ?? "");
    if (text.trim()) {
      const transcriptChunk = text.trim();
      sendToBackground({ type: "TRANSCRIPT_CHUNK", text: transcriptChunk });
      if (MEETING_ASSISTANT_SECRET) {
        void requestAssistantSuggestions(transcriptChunk, generation);
      }
    }
  }).catch((error) => {
    sendToBackground({
      type: "OFFSCREEN_ERROR",
      error: `Local transcription failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  });
}

function collectAudio(event: AudioProcessingEvent): void {
  const input = event.inputBuffer;
  const mono = new Float32Array(input.length);
  const channelCount = Math.max(1, input.numberOfChannels);

  for (let channel = 0; channel < channelCount; channel += 1) {
    const data = input.getChannelData(channel);
    for (let index = 0; index < data.length; index += 1) {
      mono[index] += data[index] / channelCount;
    }
  }

  inputBuffers.push(mono);
  bufferedSampleCount += mono.length;
  const chunkSampleCount = Math.round(inputSampleRate * CHUNK_SECONDS);

  while (bufferedSampleCount >= chunkSampleCount) {
    enqueueChunk(takeSamples(chunkSampleCount), inputSampleRate, captureGeneration);
  }
}

async function startCapture(streamId: string): Promise<void> {
  if (stream) throw new Error("Audio capture is already running.");

  captureGeneration += 1;
  inputBuffers = [];
  bufferedSampleCount = 0;
  workChain = Promise.resolve();
  previousSuggestions = [];

  const constraints = {
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  } as unknown as MediaStreamConstraints;

  stream = await navigator.mediaDevices.getUserMedia(constraints);
  audioContext = new AudioContext();
  await audioContext.resume();
  inputSampleRate = audioContext.sampleRate;
  sourceNode = audioContext.createMediaStreamSource(stream);

  // Capturing a tab suppresses its ordinary playback. This route restores the
  // meeting audio to the user's default output device.
  sourceNode.connect(audioContext.destination);

  processorNode = audioContext.createScriptProcessor(4096, 2, 1);
  silentGainNode = audioContext.createGain();
  silentGainNode.gain.value = 0;
  processorNode.onaudioprocess = collectAudio;
  sourceNode.connect(processorNode);
  processorNode.connect(silentGainNode);
  silentGainNode.connect(audioContext.destination);

  for (const track of stream.getTracks()) {
    track.addEventListener("ended", () => {
      if (!stoppingPromise) void stopCapture(true);
    }, { once: true });
  }

  // Start model loading without delaying stream-ID consumption or capture.
  void getTranscriber().catch((error) => {
    sendToBackground({
      type: "OFFSCREEN_ERROR",
      error: `Could not load the local Whisper model: ${error instanceof Error ? error.message : String(error)}`,
    });
  });
}

async function stopCapture(endedByBrowser = false): Promise<void> {
  if (stoppingPromise) return stoppingPromise;

  stoppingPromise = (async () => {
    const finalGeneration = captureGeneration;
    const finalRate = inputSampleRate;
    if (processorNode) processorNode.onaudioprocess = null;

    const finalSamples = finalRate > 0 && bufferedSampleCount >= finalRate * MINIMUM_FINAL_CHUNK_SECONDS
      ? takeSamples(bufferedSampleCount)
      : null;
    inputBuffers = [];
    bufferedSampleCount = 0;

    if (finalSamples) enqueueChunk(finalSamples, finalRate, finalGeneration);

    processorNode?.disconnect();
    silentGainNode?.disconnect();
    sourceNode?.disconnect();
    for (const track of stream?.getTracks() ?? []) track.stop();
    await audioContext?.close();

    stream = null;
    audioContext = null;
    sourceNode = null;
    processorNode = null;
    silentGainNode = null;
    inputSampleRate = 0;

    await workChain;
    if (endedByBrowser) sendToBackground({ type: "CAPTURE_ENDED" });
  })().finally(() => {
    stoppingPromise = null;
  });

  return stoppingPromise;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== "offscreen") return false;

  if (message.type === "START_CAPTURE") {
    startCapture(String(message.streamId))
      .then(() => sendResponse({ ok: true }))
      .catch(async (error) => {
        await stopCapture();
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });
    return true;
  }

  if (message.type === "STOP_CAPTURE") {
    stopCapture()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (message.type === "WARM_MODEL") {
    // Fire-and-forget: getTranscriber() caches its promise, so this just moves the
    // one-time model load earlier (popup open) instead of waiting for the Start click.
    getTranscriber().catch(() => undefined);
    sendResponse({ ok: true });
    return true;
  }

  return false;
});
