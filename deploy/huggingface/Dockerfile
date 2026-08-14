# Hugging Face Space image for SCANFORGE.
#
# The Space holds only this file and a README; the application source is pulled
# from GitHub at build time so there is one place to change code.
# Rebuild the Space to pick up new commits (Settings → Factory rebuild).

FROM node:22-bookworm-slim AS webbuild
ARG REPO=https://github.com/maxlirio/SCANFORGE
ARG REF=main
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN git clone --depth 1 --branch ${REF} ${REPO} . && npm ci && npm run build

FROM mambaorg/micromamba:1.5-bookworm-slim
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

# openimageio is explicit: conda-forge's colmap 4.1.1 links against
# libOpenImageIO.so.3.1 without depending on it, so colmap installs and then
# refuses to start.
RUN micromamba install -y -n base -c conda-forge \
      colmap=4.1.1 openimageio python=3.11 nodejs=22 numpy pillow \
    && micromamba clean --all --yes
ENV PATH=/opt/conda/bin:$PATH
RUN pip install --no-cache-dir pillow-heif==0.18.0 || true

WORKDIR /app
COPY --from=webbuild /build/node_modules ./node_modules
COPY --from=webbuild /build/package.json ./package.json
COPY --from=webbuild /build/packages ./packages
COPY --from=webbuild /build/apps/server/package.json ./apps/server/package.json
COPY --from=webbuild /build/apps/server/dist ./apps/server/dist
COPY --from=webbuild /build/apps/web/dist ./apps/web/dist
COPY --from=webbuild /build/pipeline ./pipeline

# Spaces run as uid 1000 and only /tmp and the home dir are writable.
ENV SCANFORGE_DATA_DIR=/tmp/scanforge-data \
    SCANFORGE_PYTHON=/opt/conda/bin/python \
    COLMAP_BIN=/opt/conda/bin/colmap \
    SCANFORGE_CONCURRENCY=1 \
    SCANFORGE_MAX_IMAGES=120 \
    SCANFORGE_EXHAUSTIVE_MAX=35 \
    SCANFORGE_DEFAULT_QUALITY=fast \
    SCANFORGE_RETENTION_DAYS=2 \
    SCANFORGE_MAX_JOBS=12 \
    HOST=0.0.0.0 \
    PORT=7860 \
    NODE_ENV=production
RUN mkdir -p /tmp/scanforge-data && chmod 777 /tmp/scanforge-data

EXPOSE 7860
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/server/dist/index.js"]
