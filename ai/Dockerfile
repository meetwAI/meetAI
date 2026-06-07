# ML base image for the AI services that need torch (embedder, qa-service,
# ai-worker). The gateway does NOT need any of this — it uses Dockerfile.gateway
# (slim, no CUDA) instead.
#
# Which dependency tier to install is selected per service via the REQUIREMENTS
# build arg, so each image carries only the libs that service actually imports
# (traced from the package import graph). Build context is ./ai.
#
#   embedder  -> --build-arg REQUIREMENTS=requirements/embedder.txt
#   qa        -> --build-arg REQUIREMENTS=requirements/qa.txt
#   worker    -> requirements/worker.txt (default; the full ASR/diarization stack)
FROM nvidia/cuda:12.3.2-runtime-ubuntu22.04

ARG REQUIREMENTS=requirements/worker.txt

ENV DEBIAN_FRONTEND=noninteractive
RUN for file in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do \
            if [ -f "$file" ]; then sed -i 's|http://|https://|g' "$file"; fi; \
        done \
        && apt-get update -o Acquire::Retries=3 \
        && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    git build-essential ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Copy the whole requirements tree so `-r base.txt` includes resolve. The pip
# cache mount lets rebuilds reuse already-downloaded wheels instead of
# re-fetching them; it is a BuildKit feature and is simply ignored on builders
# without BuildKit, so the build still works everywhere.
COPY requirements /workspace/requirements
RUN --mount=type=cache,target=/root/.cache/pip \
    pip3 install --upgrade pip setuptools wheel \
    && pip3 install -r "/workspace/${REQUIREMENTS}"

# Copy the package + weights. Build context is ./ai (the package root).
COPY aiengine /workspace/aiengine
COPY weights /workspace/weights

# Keep /workspace on sys.path so `python -m aiengine.*` resolves the package.
ENV PYTHONPATH=/workspace

# Overridden per service by the compose `command:`. Default to the worker.
CMD ["python3", "-m", "aiengine.worker"]
