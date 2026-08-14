---
title: SCANFORGE
emoji: 📷
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
license: mit
short_description: Photograph an object from every side, get a textured 3D model
---

# SCANFORGE

Open this Space on a phone or iPad, press **Start scan**, walk around an object
taking photos, and it reconstructs a textured 3D model you can rotate and
download as GLB / OBJ / PLY.

Reconstruction is real photogrammetry — [COLMAP](https://colmap.github.io/) solves
where every photograph was taken from, builds a surface from the points it
triangulates, and projects your photographs onto it. Nothing is generated or
substituted; if your photos cannot be reconstructed, it says so.

Source: https://github.com/maxlirio/SCANFORGE

**Notes for this free CPU Space**

- 2 vCPU, no GPU. A 30-photo scan takes a few minutes. Geometry is coarse
  (no CUDA means no dense stereo) — detail lives in the texture.
- Storage is ephemeral: scans are cleared when the Space restarts or sleeps.
  Download your model when it finishes.
- Matte, textured objects work. Shiny, glassy or plain-white ones do not.
