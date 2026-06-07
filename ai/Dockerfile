FROM nvidia/cuda:12.3.2-runtime-ubuntu22.04

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
# Split requirements: cache base.txt separately from the per-service file.
# base.txt is shared and changes rarely; the per-service file is bind-mounted
# so its cache key is just that one file's contents. Changing qa.txt only
# busts the qa-service layer — embedder/ai-worker keep their cached base +
# their own pip install layer. Requires BuildKit (same constraint as the
# pip cache mount in Dockerfile.gateway).
COPY requirements/base.txt /workspace/requirements/base.txt
ARG REQUIREMENTS=requirements/embedder.txt

# Bind-mount the per-service file by itself, copy it next to base.txt so its
# `-r base.txt` line resolves, then pip-install both. Using `--mount=bind` for
# just this one file (not the whole requirements/ dir) is what gives us the
# per-service layer caching.
RUN --mount=type=bind,source=${REQUIREMENTS},target=/tmp/req.txt \
    --mount=type=cache,target=/root/.cache/pip \
    cp /tmp/req.txt /workspace/requirements/req.txt \
    && pip install --upgrade pip \
    && pip install -r /workspace/requirements/base.txt \
                    -r /workspace/requirements/req.txt

# Copy the package + weights. Build context is ./ai (the package root).
COPY aiengine /workspace/aiengine
COPY weights /workspace/weights

# Keep /workspace on sys.path so `python -m aiengine.*` resolves the package.
ENV PYTHONPATH=/workspace

CMD ["python3", "-m", "aiengine.gateway.service"]
