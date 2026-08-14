#!/usr/bin/env python3
"""Make TRELLIS.2's background remover dtype-agnostic.

The Apple Silicon port runs the pipeline in half precision, but the matting
model's __call__ builds a float32 tensor, so it dies with

    RuntimeError: Input type (float) and bias type (c10::Half) should be the same

RMBG-2.0 happens to be loaded in a way that hides this; the ungated BiRefNet we
substitute does not. Cast the input to whatever dtype the model actually has,
and bring the prediction back to float before it becomes a PIL image.
"""
import os, sys

TARGET = os.path.expanduser(
    "~/.scanforge/trellis-mac/TRELLIS.2/trellis2/pipelines/rembg/BiRefNet.py")

OLD = """        input_images = self.transform_image(image).unsqueeze(0).to(self.device)
        # Prediction
        with torch.no_grad():
            preds = self.model(input_images)[-1].sigmoid().cpu()"""

NEW = """        model_dtype = next(self.model.parameters()).dtype
        input_images = self.transform_image(image).unsqueeze(0).to(self.device, model_dtype)
        # Prediction
        with torch.no_grad():
            preds = self.model(input_images)[-1].sigmoid().float().cpu()"""

def main() -> int:
    if not os.path.exists(TARGET):
        print(f"not found: {TARGET}", file=sys.stderr)
        return 1
    text = open(TARGET, encoding="utf-8").read()
    if NEW in text:
        print("already patched")
        return 0
    if OLD not in text:
        print("upstream code changed; patch not applied", file=sys.stderr)
        return 1
    open(TARGET, "w", encoding="utf-8").write(text.replace(OLD, NEW))
    print(f"patched {TARGET}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
