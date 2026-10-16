# The instances' computers (ADR 0013): docker build -f docker/computer.Dockerfile -t annie-computer:latest .
# Annie runs it with no network, as uid 1000, read-only except /work and /tmp. The tools here are
# all a computer has: it cannot install anything at run time.
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates coreutils file bc jq sqlite3 zip unzip xz-utils \
      python3 python3-pandas python3-openpyxl python3-matplotlib python3-pypdf \
      pandoc poppler-utils qpdf imagemagick ghostscript fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 1000 annie && useradd -u 1000 -g 1000 -d /tmp -s /bin/sh annie \
 && mkdir /work && chown 1000:1000 /work

USER 1000:1000
WORKDIR /work
ENV HOME=/tmp LANG=C.UTF-8 MPLBACKEND=Agg
CMD ["sleep", "infinity"]
