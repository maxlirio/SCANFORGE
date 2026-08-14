# SCANFORGE — one container that serves the website AND does the reconstruction.
#
# The whole point: a phone visits a URL and everything happens server-side. No
# laptop involved. Frontend and API share one origin, so there is no CORS and no
# mixed-content problem when the host terminates HTTPS.
#
#   docker build -t scanforge .
#   docker run -p 7860:7860 scanforge
#
# COLMAP 4.1 is what makes CPU-only reconstruction possible (it added CPU meshing
# and texture-atlas generation). Distro packages are still on 3.x, so it comes
# from conda-forge, which publishes a 4.1.1 linux build - a binary install rather
# than a 40-minute source build.

# ---------- stage 1: build the TypeScript ----------
FROM node:22-bookworm-slim AS webbuild
WORKDIR /build
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
RUN npm run build

# ---------- stage 2: runtime ----------
FROM mambaorg/micromamba:1.5-bookworm-slim

USER root
ENV DEBIAN_FRONTEND=noninteractive
# curl/git/tar/gzip/procps are not optional extras here: a Codespace bootstraps
# its VS Code server inside this image and needs them, and the slim base has
# none of them. Without these the container fails before the app runs, which
# surfaces only as an unexplained "configuration error".
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates tini curl git tar gzip procps \
    && rm -rf /var/lib/apt/lists/*

# COLMAP (BSD-3) plus the pipeline's Python and the Node runtime, all from
# conda-forge so the image builds in minutes instead of compiling COLMAP.
# openimageio is listed explicitly: the conda-forge colmap 4.1.1 build links
# against libOpenImageIO.so.3.1 but does not pull it in, so colmap installs
# "successfully" and then refuses to start.
RUN micromamba install -y -n base -c conda-forge \
      colmap=4.1.1 \
      openimageio \
      python=3.11 \
      nodejs=22 \
      numpy \
      pillow \
    && micromamba clean --all --yes
ENV PATH=/opt/conda/bin:$PATH
# A login shell re-reads /etc/profile and would drop the ENV PATH above, hiding
# node, python and colmap from anything that runs through `sh -l` - which is
# how Codespaces and most CI shells invoke commands.
RUN printf 'export PATH=/opt/conda/bin:$PATH\n' > /etc/profile.d/10-scanforge-conda.sh

# HEIC comes straight off iPhones; Pillow needs help to read it.
RUN pip install --no-cache-dir pillow-heif==0.18.0 || \
    echo "pillow-heif unavailable; HEIC uploads will be rejected with a clear message"

WORKDIR /app
COPY --from=webbuild /build/package.json /build/package-lock.json ./
COPY --from=webbuild /build/node_modules ./node_modules
COPY --from=webbuild /build/packages ./packages
COPY --from=webbuild /build/apps/server/package.json ./apps/server/
COPY --from=webbuild /build/apps/server/dist ./apps/server/dist
COPY --from=webbuild /build/apps/web/dist ./apps/web/dist
COPY pipeline ./pipeline

# Hosted free tiers give you a writable working directory and nothing else, so
# scans live here and are pruned by age. Mount a volume for persistence.
ENV SCANFORGE_DATA_DIR=/data \
    SCANFORGE_PYTHON=/opt/conda/bin/python \
    COLMAP_BIN=/opt/conda/bin/colmap \
    SCANFORGE_CONCURRENCY=1 \
    HOST=0.0.0.0 \
    PORT=7860 \
    NODE_ENV=production
RUN mkdir -p /data && chmod 777 /data

EXPOSE 7860

# COLMAP shells out; tini reaps the children so cancelled scans don't linger.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/server/dist/index.js"]
