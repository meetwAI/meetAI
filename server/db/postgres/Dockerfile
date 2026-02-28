FROM postgres:15

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     build-essential \
     git \
     ca-certificates \
     wget \
     postgresql-server-dev-15 \
  && git clone --depth 1 https://github.com/pgvector/pgvector.git /tmp/pgvector \
  && cd /tmp/pgvector \
  && make && make install \
  && rm -rf /tmp/pgvector \
  && apt-get remove -y build-essential git \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*
