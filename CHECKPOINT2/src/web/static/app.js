const statusEl = document.getElementById("status");
const wsInput = document.getElementById("wsInput");
const shareTabBtn = document.getElementById("shareTabBtn");
const useMicBtn = document.getElementById("useMicBtn");
const stopBtn = document.getElementById("stopBtn");
const linesTranscriptEl = document.getElementById("linesTranscript");

let websocket = null;
let mediaStream = null;
let audioContext = null;
let sourceNode = null;
let workletNode = null;
let recorderWorker = null;
let isRecording = false;
let waitingForStop = false;
let lastPayload = null;
let emptyStateVisible = false;

const protocol = window.location.protocol === "https:" ? "wss" : "ws";
const defaultWs = `${protocol}://${window.location.host}/asr`;
wsInput.value = defaultWs;

function setStatus(text) {
  statusEl.textContent = text;
}

function setControls(active, processing = false) {
  isRecording = active;
  waitingForStop = processing;
  shareTabBtn.disabled = active || processing;
  useMicBtn.disabled = active || processing;
  stopBtn.disabled = !active;
}

async function connectWebSocket() {
  const wsUrl = wsInput.value.trim() || defaultWs;
  return new Promise((resolve, reject) => {
    let opened = false;

    websocket = new WebSocket(wsUrl);

    websocket.onopen = () => {
      opened = true;
      setStatus("Connected. Waiting for audio stream...");
      resolve();
    };

    websocket.onerror = () => {
      if (!opened) {
        reject(new Error("Failed to connect websocket"));
      }
      setStatus("WebSocket error");
    };

    websocket.onclose = () => {
      if (waitingForStop) {
        setStatus("Session finalized.");
      } else if (isRecording) {
        setStatus("Disconnected while recording.");
      } else {
        setStatus("Disconnected.");
      }
      cleanupCapture();
      setControls(false, false);
      websocket = null;
    };

    websocket.onmessage = (event) => {
      const payload = JSON.parse(event.data);

      if (payload.type === "config") {
        setStatus("Connected. Capturing PCM audio.");
        return;
      }

      if (payload.type === "ready_to_stop") {
        if (lastPayload) {
          renderTranscript(lastPayload, true);
        }
        waitingForStop = false;
        setControls(false, false);
        setStatus("Finished processing audio.");
        if (websocket && websocket.readyState === WebSocket.OPEN) {
          websocket.close();
        }
        return;
      }

      lastPayload = payload;
      renderTranscript(payload, false);
    };
  });
}

function speakerBadge(speaker) {
  if (speaker === -2) {
    return `<span class="meta silence">Silence</span>`;
  }
  return `<span class="meta speaker">Speaker ${speaker}</span>`;
}

function renderTranscript(payload, isFinal) {
  const lines = payload.lines || [];
  const tentative = payload.buffer_transcription || "";
  const tentativeDiar = payload.buffer_diarization || "";

  if (!lines.length && !tentative && !tentativeDiar) {
    if (!emptyStateVisible) {
      linesTranscriptEl.innerHTML = `<p class="empty">No audio detected yet...</p>`;
      emptyStateVisible = true;
    }
    return;
  }

  emptyStateVisible = false;

  const shouldStickToBottom =
    linesTranscriptEl.scrollHeight - linesTranscriptEl.scrollTop - linesTranscriptEl.clientHeight <
    40;

  const lineEntries = lines.length
    ? lines
    : [
        {
          speaker: -1,
          text: "",
          start: null,
          end: null,
          detected_language: null,
        },
      ];

  while (linesTranscriptEl.children.length > lineEntries.length) {
    linesTranscriptEl.removeChild(linesTranscriptEl.lastElementChild);
  }

  lineEntries.forEach((line, idx) => {
    const isLast = idx === lineEntries.length - 1;
    let text = line.text || "";

    if (isLast && tentativeDiar) {
      text += isFinal
        ? ` ${tentativeDiar}`
        : ` <span class="buffer">${tentativeDiar}</span>`;
    }
    if (isLast && tentative) {
      text += isFinal ? ` ${tentative}` : ` <span class="buffer">${tentative}</span>`;
    }

    const times = line.start != null && line.end != null ? `${line.start} - ${line.end}` : "";
    const lang = line.detected_language
      ? `<span class="meta lang">${line.detected_language}</span>`
      : "";

    const meta =
      line.speaker === -1 && !times && !lang
        ? ""
        : `<div class="line-meta">${speakerBadge(line.speaker)}${
            times ? `<span class="meta time">${times}</span>` : ""
          }${lang}</div>`;

    const nextHtml = `${meta}<p class="line-text">${text}</p>`;

    let article = linesTranscriptEl.children[idx];
    if (!article || !article.classList.contains("line")) {
      const replacement = document.createElement("article");
      replacement.className = "line";
      if (article) {
        linesTranscriptEl.replaceChild(replacement, article);
      } else {
        linesTranscriptEl.appendChild(replacement);
      }
      article = replacement;
    }

    if (article.dataset.rendered !== nextHtml) {
      article.innerHTML = nextHtml;
      article.dataset.rendered = nextHtml;
    }
  });

  if (shouldStickToBottom) {
    linesTranscriptEl.scrollTop = linesTranscriptEl.scrollHeight;
  }
}

async function startCapture(streamPromise) {
  try {
    await connectWebSocket();

    mediaStream = await streamPromise;
    audioContext = new AudioContext();

    await audioContext.audioWorklet.addModule("/static/pcm_worklet.js");
    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioContext, "pcm-forwarder", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
    });

    recorderWorker = new Worker("/static/recorder_worker.js");
    recorderWorker.postMessage({
      command: "init",
      config: {
        sampleRate: audioContext.sampleRate,
        targetSampleRate: 16000,
      },
    });

    recorderWorker.onmessage = (e) => {
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(e.data.buffer);
      }
    };

    workletNode.port.onmessage = (e) => {
      const data = e.data;
      const ab = data instanceof ArrayBuffer ? data : data.buffer;
      recorderWorker.postMessage({ command: "record", buffer: ab }, [ab]);
    };

    sourceNode.connect(workletNode);

    setControls(true, false);
    setStatus("Streaming audio...");
  } catch (err) {
    cleanupCapture();
    setControls(false, false);
    setStatus(`Failed to start: ${err.message}`);
  }
}

async function startTabCapture() {
  const streamPromise = navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      sampleRate: 48000,
      channelCount: 1,
    },
  });
  await startCapture(streamPromise);
}

async function startMicCapture() {
  const streamPromise = navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      channelCount: 1,
    },
  });
  await startCapture(streamPromise);
}

async function stopCapture() {
  if (!isRecording || !websocket || websocket.readyState !== WebSocket.OPEN) {
    cleanupCapture();
    setControls(false, false);
    return;
  }

  setControls(false, true);
  setStatus("Stopping capture. Waiting for final transcript...");

  websocket.send(new ArrayBuffer(0));
  cleanupCapture();
}

function cleanupCapture() {
  if (workletNode) {
    try {
      workletNode.disconnect();
    } catch (_err) {}
    workletNode = null;
  }

  if (sourceNode) {
    try {
      sourceNode.disconnect();
    } catch (_err) {}
    sourceNode = null;
  }

  if (recorderWorker) {
    recorderWorker.terminate();
    recorderWorker = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }

  if (audioContext && audioContext.state !== "closed") {
    audioContext.close().catch(() => {});
  }
  audioContext = null;

  isRecording = false;
}

shareTabBtn.addEventListener("click", () => {
  startTabCapture();
});

useMicBtn.addEventListener("click", () => {
  startMicCapture();
});

stopBtn.addEventListener("click", () => {
  stopCapture();
});

setStatus("Ready. Click Share Tab or Use Microphone.");
