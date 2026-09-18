export {};

type CaptureStatus = "idle" | "starting" | "loading_model" | "capturing" | "stopping" | "sending" | "error";

interface CaptureState {
  status: CaptureStatus;
  transcript: string;
  suggestions: string[];
  message: string;
  progress?: number;
  tabId?: number;
  captureId?: string;
  suggestedClient?: { clientId: string; clientName: string; clientEmail: string } | null;
}

const STORAGE_KEY = "captureState";
const SETTINGS_KEY = "conductflowSettings";
const OFFSCREEN_PATH = "offscreen.html";
const INITIAL_STATE: CaptureState = {
  status: "idle",
  transcript: "",
  suggestions: [],
  message: "Ready.",
};

/**
 * Configured once, in the popup's Setup section, and reused for every capture after that.
 * The token is the same kind minted at /settings/desktop for the Mac app — this extension
 * authenticates against the identical /api/desktop/execute endpoint, no separate backend
 * route needed for it.
 */
interface ConductFlowSettings {
  apiBase: string;
  token: string;
  clientName: string;
  clientEmail: string;
  autoSend: boolean;
  identifiedEmail?: string;
}

const DEFAULT_SETTINGS: ConductFlowSettings = {
  apiBase: "https://conductflow.tech",
  token: "",
  clientName: "",
  clientEmail: "",
  autoSend: true,
};

async function readSettings(): Promise<ConductFlowSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = stored[SETTINGS_KEY] as Partial<ConductFlowSettings> | undefined;
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function writeSettings(settings: ConductFlowSettings): Promise<ConductFlowSettings> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

/** Best-effort identification using this browser's existing ConductFlow session. */
async function trySessionLogin(): Promise<{ ok: true; email: string } | { ok: false }> {
  try {
    const settings = await readSettings();
    const response = await fetch(`${settings.apiBase}/api/extension/session`, {
      credentials: "include",
    });
    if (response.status !== 200) return { ok: false };
    const body = await response.json();
    if (!body || typeof body.email !== "string" || !body.email.trim()) return { ok: false };
    const current = await readSettings();
    if (Object.hasOwn(body, "token")) {
      if (typeof body.token !== "string" || !body.token) return { ok: false };
      await writeSettings({ ...current, token: body.token, clientEmail: current.clientEmail || body.email, identifiedEmail: body.email });
    } else {
      await writeSettings({ ...current, identifiedEmail: body.email });
    }
    return { ok: true, email: body.email };
  } catch {
    return { ok: false };
  }
}

interface SendResult {
  ok: boolean;
  message: string;
  commitmentCount?: number;
}

/**
 * Same endpoint the packaged Mac app calls. The bearer token proves which workspace this
 * is, org id is resolved server-side from it and never trusted from this request body, so
 * there is nothing extra to secure here beyond keeping the token itself private.
 */
interface ClientOverride { clientName: string; clientEmail: string; }

function readOverride(value: unknown): ClientOverride | undefined {
  if (!value || typeof value !== "object" || !("clientName" in value) || !("clientEmail" in value) ||
    typeof value.clientName !== "string" || typeof value.clientEmail !== "string") return undefined;
  return { clientName: value.clientName.trim(), clientEmail: value.clientEmail.trim() };
}

async function sendTranscript(text: string, title: string, override?: ClientOverride): Promise<SendResult> {
  const settings = await readSettings();
  if (!settings.token) {
    return { ok: false, message: "No workspace token configured yet, open Setup above." };
  }
  const state = await readState();
  const client = override ?? state.suggestedClient ?? settings;
  if (!client.clientEmail.trim()) {
    return { ok: false, message: "No client identified — set one in Setup or wait for a calendar match." };
  }

  try {
    const response = await fetch(`${settings.apiBase}/api/desktop/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.token}`,
      },
      body: JSON.stringify({
        text,
        clientName: client.clientName || client.clientEmail,
        clientEmail: client.clientEmail,
        title,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
      return { ok: false, message: `ConductFlow rejected the transcript: ${detail}` };
    }
    const count = typeof payload.commitmentCount === "number" ? payload.commitmentCount : 0;
    return {
      ok: true,
      commitmentCount: count,
      message: count > 0
        ? `Sent — ${count} commitment${count === 1 ? "" : "s"} waiting for your approval in the queue.`
        : "Sent to ConductFlow. Nothing that looked like a commitment was found this time.",
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Could not reach ConductFlow: ${detail}` };
  }
}

let creatingOffscreenDocument: Promise<void> | null = null;
let operation: Promise<unknown> = Promise.resolve();

async function readState(): Promise<CaptureState> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const state = stored[STORAGE_KEY] as CaptureState | undefined;
  if (!state) return INITIAL_STATE;
  return { ...state, suggestions: Array.isArray(state.suggestions) ? state.suggestions : [] };
}

async function publishState(next: CaptureState): Promise<CaptureState> {
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  void chrome.runtime.sendMessage({ target: "popup", type: "STATE_UPDATED", state: next }).catch(() => {
    // The popup is normally closed; absence of a listener is expected.
  });
  return next;
}

async function ensureOffscreenDocument(): Promise<void> {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [documentUrl],
  });
  if (contexts.length > 0) return;

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ["USER_MEDIA"],
        justification: "Capture and locally transcribe audio from the user-selected browser tab.",
      })
      .finally(() => {
        creatingOffscreenDocument = null;
      });
  }
  await creatingOffscreenDocument;
}

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function suggestMeetingClient(captureId: string, startedAt: string): Promise<void> {
  try {
    const settings = await readSettings();
    if (!settings.token) return;
    const response = await fetch(`${settings.apiBase}/api/extension/current-meeting`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.token}` },
      body: JSON.stringify({ startedAt }),
    });
    if (!response.ok) return;
    const { match } = await response.json();
    if (!match || typeof match.clientId !== "string" || typeof match.clientName !== "string" ||
      typeof match.clientEmail !== "string") return;
    // Merge through the message queue so a slow lookup cannot overwrite transcript updates.
    const task = operation.then(async () => {
      const current = await readState();
      if (current.captureId !== captureId || !["loading_model", "capturing"].includes(current.status)) return;
      await publishState({ ...current, suggestedClient: match });
    });
    operation = task.catch(() => undefined);
    await task;
  } catch {
    // Calendar context is optional and must never interrupt audio capture.
  }
}

async function startCapture(tabId: number): Promise<CaptureState> {
  const current = await readState();
  if (["starting", "loading_model", "capturing", "stopping"].includes(current.status)) {
    throw new Error("A tab capture is already in progress.");
  }

  const captureId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  await publishState({
    captureId,
    status: "starting", transcript: "", suggestions: [],
    message: "Preparing the audio processor…", tabId,
  });
  try {
    await ensureOffscreenDocument();

    // Chrome 116+ permits a stream ID created in an extension service worker to
    // be consumed by an offscreen document from the same extension origin.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    const response = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "START_CAPTURE",
      streamId,
    }) as { ok: boolean; error?: string };

    if (!response?.ok) {
      throw new Error(response?.error ?? "The offscreen document could not start audio capture.");
    }

    const started = await publishState({
      captureId,
      status: "loading_model",
      transcript: "",
      suggestions: [],
      message: "Capturing audio; loading the local Whisper model…",
      tabId,
    });
    void suggestMeetingClient(captureId, startedAt);
    return started;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await publishState({ status: "error", transcript: "", suggestions: [], message });
    throw error;
  }
}

async function stopCapture(override?: ClientOverride): Promise<CaptureState> {
  const current = await readState();
  if (!["starting", "loading_model", "capturing", "stopping"].includes(current.status)) {
    return current;
  }

  await publishState({ ...current, status: "stopping", message: "Stopping and finishing queued audio…" });
  try {
    if (await hasOffscreenDocument()) {
      const response = await chrome.runtime.sendMessage({ target: "offscreen", type: "STOP_CAPTURE" }) as {
        ok: boolean;
        error?: string;
      };
      if (!response?.ok) throw new Error(response?.error ?? "The audio processor did not stop cleanly.");
    }
    const latest = await readState();
    const settings = await readSettings();
    if (settings.autoSend && latest.transcript.trim()) {
      await publishState({
        ...latest, status: "sending", transcript: latest.transcript,
        suggestions: latest.suggestions, message: "Sending transcript to ConductFlow…",
      });
      const title = `Meeting captured ${new Date().toLocaleDateString()}`;
      const result = await sendTranscript(latest.transcript, title, override);
      return publishState({
        ...latest, status: result.ok ? "idle" : "error", transcript: latest.transcript,
        suggestions: latest.suggestions, message: result.message,
      });
    }
    return publishState({
      ...latest, status: "idle", transcript: latest.transcript,
      suggestions: latest.suggestions, message: "Stopped.",
    });
  } catch (error) {
    const latest = await readState();
    const message = error instanceof Error ? error.message : String(error);
    return publishState({
      ...latest, status: "error", transcript: latest.transcript,
      suggestions: latest.suggestions, message,
    });
  }
}

async function handleOffscreenMessage(message: Record<string, unknown>): Promise<void> {
  const current = await readState();

  if (message.type === "MODEL_PROGRESS") {
    if (!["starting", "loading_model", "capturing"].includes(current.status)) return;
    const progress = typeof message.progress === "number" ? message.progress : undefined;
    await publishState({
      ...current,
      status: "loading_model",
      message: typeof message.message === "string" ? message.message : "Loading the local Whisper model…",
      progress,
    });
    return;
  }

  if (message.type === "MODEL_READY") {
    if (!["starting", "loading_model", "capturing"].includes(current.status)) return;
    await publishState({ ...current, status: "capturing", message: "Capturing and transcribing locally.", progress: undefined });
    return;
  }

  if (message.type === "TRANSCRIPT_CHUNK") {
    const text = typeof message.text === "string" ? message.text.trim() : "";
    if (!text) return;
    const transcript = current.transcript ? `${current.transcript}\n${text}` : text;
    await publishState({ ...current, transcript });
    return;
  }

  if (message.type === "ASSISTANT_SUGGESTION") {
    const text = typeof message.text === "string" ? message.text.trim() : "";
    if (!text || current.suggestions.includes(text)) return;
    await publishState({ ...current, suggestions: [...current.suggestions, text] });
    return;
  }

  if (message.type === "CAPTURE_ENDED") {
    await publishState({
      ...current, status: "idle", transcript: current.transcript, suggestions: current.suggestions,
      message: "The captured tab stopped sending audio.",
    });
    return;
  }

  if (message.type === "OFFSCREEN_ERROR") {
    const detail = typeof message.error === "string" ? message.error : "The local audio processor failed.";
    if (await hasOffscreenDocument()) {
      await chrome.runtime.sendMessage({ target: "offscreen", type: "STOP_CAPTURE" }).catch(() => undefined);
    }
    const latest = await readState();
    await publishState({
      ...latest, status: "error", transcript: latest.transcript,
      suggestions: latest.suggestions, message: detail,
    });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.set({ [STORAGE_KEY]: INITIAL_STATE });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== "background") return false;

  const task = operation.then(async () => {
    if (message.type === "AUTO_LOGIN") {
      return { ok: true, result: await trySessionLogin() };
    }

    if (message.type === "GET_SETTINGS") {
      return { ok: true, settings: await readSettings() };
    }

    if (message.type === "SET_SETTINGS") {
      const incoming = (message.settings ?? {}) as Partial<ConductFlowSettings>;
      const current = await readSettings();
      const next = { ...current, ...incoming };
      if (incoming.token !== undefined && incoming.token !== current.token) next.identifiedEmail = undefined;
      return { ok: true, settings: await writeSettings(next) };
    }

    if (message.type === "GET_STATE") {
      let state = await readState();
      if (["starting", "loading_model", "capturing", "stopping"].includes(state.status) && !(await hasOffscreenDocument())) {
        state = await publishState({
          ...state, status: "idle",
          transcript: state.transcript,
          suggestions: state.suggestions,
          message: "Capture is no longer running.",
        });
      }
      return { ok: true, state };
    }

    if (message.type === "WARM_MODEL") {
      const current = await readState();
      if (["starting", "loading_model", "capturing", "stopping"].includes(current.status)) {
        return { ok: true };
      }
      try {
        await ensureOffscreenDocument();
        await chrome.runtime.sendMessage({ target: "offscreen", type: "WARM_MODEL" });
      } catch {
        // Best-effort warm-up; the model will still load normally on Start if this fails.
      }
      return { ok: true };
    }

    if (message.type === "START_CAPTURE") {
      if (typeof message.tabId !== "number") throw new Error("No active tab was selected.");
      return { ok: true, state: await startCapture(message.tabId) };
    }

    if (message.type === "STOP_CAPTURE") {
      return { ok: true, state: await stopCapture(readOverride(message.override)) };
    }

    if (message.type === "SEND_TRANSCRIPT") {
      const current = await readState();
      const text = typeof message.text === "string" ? message.text : current.transcript;
      const title = `Meeting captured ${new Date().toLocaleDateString()}`;
      return { ok: true, result: await sendTranscript(text, title, readOverride(message.override)) };
    }

    if (typeof message.type === "string") {
      await handleOffscreenMessage(message as Record<string, unknown>);
      return { ok: true };
    }

    throw new Error("Unknown extension message.");
  });

  // Keep later messages serial even when one operation fails, while returning
  // the original failure to the caller that triggered it.
  operation = task.then(() => undefined, () => undefined);
  task
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});
