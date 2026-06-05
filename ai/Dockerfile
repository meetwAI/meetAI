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
COPY requirements.txt /workspace/requirements.txt
RUN pip3 install --no-cache-dir --upgrade pip setuptools wheel \
    && pip3 install --no-cache-dir -r /workspace/requirements.txt

# Copy the package + weights. Build context is ./ai (the package root).
COPY aiengine /workspace/aiengine
COPY weights /workspace/weights

# Keep /workspace on sys.path so `python -m aiengine.*` resolves the package.
ENV PYTHONPATH=/workspace

CMD ["python3", "-m", "aiengine.gateway.service"]
