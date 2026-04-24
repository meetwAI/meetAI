let sampleRate = 48000;
let targetSampleRate = 16000;

self.onmessage = (event) => {
  switch (event?.data?.command) {
    case 'init':
      init(event.data.config || {});
      break;
    case 'record':
      record(event.data.buffer);
      break;
    default:
      break;
  }
};

function init(config) {
  sampleRate = Number(config.sampleRate) || 48000;
  targetSampleRate = Number(config.targetSampleRate) || 16000;
}

function record(inputBuffer) {
  if (!inputBuffer) {
    return;
  }

  const buffer = new Float32Array(inputBuffer);
  const resampledBuffer = resample(buffer, sampleRate, targetSampleRate);
  const pcmBuffer = toPCM(resampledBuffer);
  self.postMessage({ buffer: pcmBuffer }, [pcmBuffer]);
}

function resample(buffer, from, to) {
  if (from === to) {
    return buffer;
  }

  const ratio = from / to;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;

    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i += 1) {
      accum += buffer[i];
      count += 1;
    }

    result[offsetResult] = count ? accum / count : 0;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }

  return result;
}

function toPCM(input) {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < input.length; i += 1) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}
