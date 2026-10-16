# The instances' computers (ADR 0013): docker build -f docker/computer.Dockerfile -t annie-computer:latest docker
# Annie runs it with no network, read-only except /work and /tmp: commands as uid 1000, the
# container itself idles as nobody. The tools here are all a computer has: it cannot install
# anything at run time. A custom image keeps uid 1000, /work owned by it, sh, timeout, du and chmod.
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates coreutils file bc jq sqlite3 zip unzip xz-utils \
      python3 python3-pandas python3-openpyxl python3-xlrd python3-matplotlib python3-pypdf weasyprint \
      pandoc poppler-utils qpdf imagemagick ghostscript fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 1000 annie && useradd -u 1000 -g 1000 -d /tmp -s /bin/sh annie \
 && mkdir /work && chown 1000:1000 /work

USER 1000:1000
WORKDIR /work
ENV HOME=/tmp LANG=C.UTF-8 MPLBACKEND=Agg
CMD ["sleep", "infinity"]
