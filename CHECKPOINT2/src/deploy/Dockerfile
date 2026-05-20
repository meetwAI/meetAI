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

WORKDIR /workspace/src
COPY requirements.txt /workspace/src/requirements.txt
RUN pip3 install --no-cache-dir --upgrade pip setuptools wheel \
    && pip3 install --no-cache-dir -r /workspace/src/requirements.txt

COPY . /workspace/src

# Keep the package parent on sys.path so `python -m src...` works.
ENV PYTHONPATH=/workspace

CMD ["python3", "-m", "src.app.server"]
