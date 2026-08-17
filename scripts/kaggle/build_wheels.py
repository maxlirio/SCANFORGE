"""Build TRELLIS.2's CUDA extensions once, as wheels, for reuse on every run.

TRELLIS.2's setup.sh compiles five extensions from source. That is 15-30 minutes
we do not want to pay per generation, so this builds them against Kaggle's own
torch/CUDA and leaves wheels in /kaggle/working for packaging as a dataset.

Each extension is built independently: some are optional at inference (we have our
own texture baker), so a partial success is still a usable result. flash-attn is
skipped deliberately - the free GPU is a P100 (capability 6.0) and flash-attn
needs 7.5+, so the sdpa attention path is the one that will actually run.
"""
import json, os, subprocess, sys, time

T0 = time.time()
OUT = "/kaggle/working"
WHEELS = f"{OUT}/wheels"
os.makedirs(WHEELS, exist_ok=True)
# Build for Pascal (P100) and Turing (T4), the two free Kaggle accelerators.
os.environ["TORCH_CUDA_ARCH_LIST"] = "6.0;7.5"
os.environ["MAX_JOBS"] = "4"

def sh(cmd, timeout=3600, quiet=False):
    t = time.time()
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
    dt = time.time() - t
    if not quiet:
        print(f"$ {cmd[:120]}\n  exit {p.returncode} in {dt:.0f}s", flush=True)
        if p.returncode != 0:
            print("  " + ((p.stderr or "")[-1800:]).replace("\n", "\n  "), flush=True)
    return p.returncode, dt

# Kaggle's own torch (2.10+cu128) supports sm_70+, which excludes the free tier's
# default P100 (sm_60). torch 2.6.0+cu124 - the version TRELLIS pins anyway - ships
# sm_50 through sm_90, so install that first and build the extensions against it.
# Verified on Kaggle: 2.10 arch list is sm_70..sm_120; 2.6 includes sm_60 and a
# conv2d runs on the P100.
sh("pip install -q torch==2.6.0 torchvision==0.21.0 "
   "--index-url https://download.pytorch.org/whl/cu124", timeout=2400)

import torch
print("torch", torch.__version__, "cuda", torch.version.cuda,
      "| gpu", torch.cuda.get_device_name(0),
      "| archs", torch.cuda.get_arch_list(), flush=True)
assert torch.__version__.startswith("2.6"), "torch 2.6 did not install; wheels would not match"

print(f"\n=== [{time.time()-T0:.0f}s] clone ===", flush=True)
sh("git clone --depth 1 --recurse-submodules https://github.com/microsoft/TRELLIS.2.git /kaggle/T2")

# setup.sh stages each extension into /tmp/extensions before installing it, so run
# it for the extensions we want and then build wheels from whatever it staged.
print(f"\n=== [{time.time()-T0:.0f}s] stage extensions via setup.sh ===", flush=True)
sh("cd /kaggle/T2 && bash setup.sh --cumesh --o-voxel --flexgemm --nvdiffrast --nvdiffrec "
   "> /kaggle/working/setup_sh.log 2>&1 || true", timeout=5400)
sh("tail -40 /kaggle/working/setup_sh.log")
sh("ls -la /tmp/extensions 2>/dev/null || echo 'no /tmp/extensions'")

results = {}
candidates = []
if os.path.isdir("/tmp/extensions"):
    candidates = [os.path.join("/tmp/extensions", d) for d in sorted(os.listdir("/tmp/extensions"))
                  if os.path.isdir(os.path.join("/tmp/extensions", d))]
print(f"\nextension sources found: {[os.path.basename(c) for c in candidates]}", flush=True)

for src in candidates:
    name = os.path.basename(src)
    print(f"\n=== [{time.time()-T0:.0f}s] wheel: {name} ===", flush=True)
    code, dt = sh(f"pip wheel '{src}' -w {WHEELS} --no-build-isolation --no-deps", timeout=3600)
    results[name] = {"ok": code == 0, "seconds": round(dt)}

# Whatever setup.sh already installed is also worth capturing, in case a wheel
# build failed but the installed package works.
print(f"\n=== [{time.time()-T0:.0f}s] installed extension packages ===", flush=True)
sh("pip list 2>/dev/null | grep -iE 'cumesh|voxel|flexgemm|nvdiff|utils3d|trellis' || true")

manifest = {
    "torch": torch.__version__,
    "cuda": torch.version.cuda,
    "gpu": torch.cuda.get_device_name(0),
    "arch_list": os.environ["TORCH_CUDA_ARCH_LIST"],
    "results": results,
    "wheels": sorted(os.listdir(WHEELS)),
    "built_at": time.strftime("%Y-%m-%d %H:%M:%S"),
}
with open(f"{OUT}/manifest.json", "w") as fh:
    json.dump(manifest, fh, indent=2)
print("\n=== MANIFEST ===", flush=True)
print(json.dumps(manifest, indent=2), flush=True)
print(f"\ntotal {time.time()-T0:.0f}s", flush=True)
