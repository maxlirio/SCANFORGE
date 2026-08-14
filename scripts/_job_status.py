"""Print a one-line status for a job (used by e2e_test.sh)."""
import json, sys

mode = sys.argv[1] if len(sys.argv) > 1 else "line"
job = json.load(sys.stdin)

if mode == "line":
    active = [s for s in job["stages"] if s["status"] == "active"]
    msg = active[0]["message"] if active else ""
    pct = active[0]["progress"] if active else None
    suffix = "" if pct is None else " {}%".format(round(pct * 100))
    print(job["status"], msg + suffix)
else:
    print("status:", job["status"])
    if job.get("error"):
        print("error:", job["error"]["message"])
    for f in job["files"]:
        print("  {:<18} {:>12,} bytes".format(f["name"], f["bytes"]))
    r = job.get("result") or {}
    keys = ("tier", "photosRegistered", "points", "vertices", "triangles",
            "textured", "durationSeconds", "upAxisConfidence")
    if r:
        print({k: r[k] for k in keys if k in r})
