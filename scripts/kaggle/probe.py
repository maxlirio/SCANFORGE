"""SCANFORGE feasibility probe: can Kaggle's GPU run TRELLIS.2, and at what cost?

Answers, in order of risk:
  1. Which GPU, which compute capability, how much VRAM.
  2. Do TRELLIS.2's CUDA extensions install, and how long does that take?
  3. How long does the 16 GB weight download take on Kaggle's network?
  4. Does a generation actually complete, and how fast?
Each stage is timed and failures are reported rather than fatal, so even a partial
run tells us where the wall is.
"""
import os, subprocess, sys, time, traceback

T0 = time.time()
def stage(name):
    print(f"\n=== [{time.time()-T0:7.1f}s] {name} ===", flush=True)

def sh(cmd, timeout=1800):
    t = time.time()
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
    print(f"$ {cmd}\n  -> exit {p.returncode} in {time.time()-t:.0f}s", flush=True)
    tail = (p.stdout or "")[-1500:] + (p.stderr or "")[-2500:]
    print("  " + tail.replace("\n", "\n  ")[-3500:], flush=True)
    return p.returncode

stage("hardware")
sh("nvidia-smi")
import torch
print("torch", torch.__version__, "| cuda", torch.version.cuda, flush=True)
if torch.cuda.is_available():
    cap = torch.cuda.get_device_capability()
    print("gpu:", torch.cuda.get_device_name(0),
          "| capability", cap,
          "| vram %.1f GB" % (torch.cuda.get_device_properties(0).total_memory/1e9),
          flush=True)
    print("flash-attn needs capability >= 7.5 ->",
          "OK" if cap >= (7, 5) else "NOT SUPPORTED (Pascal); must use sdpa", flush=True)
    print("bf16 supported ->", torch.cuda.is_bf16_supported(), flush=True)

stage("clone TRELLIS.2")
sh("git clone --depth 1 --recurse-submodules https://github.com/microsoft/TRELLIS.2.git /kaggle/working/T2")
for f in ["setup.sh", "requirements.txt", "README.md", "pyproject.toml"]:
    p = f"/kaggle/working/T2/{f}"
    if os.path.exists(p):
        print(f"\n----- {f} (first 60 lines) -----", flush=True)
        print("\n".join(open(p, errors="replace").read().splitlines()[:60]), flush=True)

stage("what does its installer want?")
sh("ls /kaggle/working/T2")
sh("grep -rioE 'pip install [^\"'\\''|;&]{0,120}' /kaggle/working/T2/setup.sh | head -40 || true")

stage("weights download speed (TRELLIS.2-4B, ~16 GB)")
t = time.time()
try:
    from huggingface_hub import snapshot_download
    path = snapshot_download("microsoft/TRELLIS.2-4B", max_workers=8)
    size = sum(os.path.getsize(os.path.join(r, f))
               for r, _, fs in os.walk(path) for f in fs)
    dt = time.time() - t
    print(f"downloaded {size/1e9:.1f} GB in {dt:.0f}s ({size/1e6/max(dt,1):.0f} MB/s)", flush=True)
except Exception:
    traceback.print_exc()

stage("done")
print(f"total {time.time()-T0:.0f}s", flush=True)
