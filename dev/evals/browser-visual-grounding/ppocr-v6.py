#!/usr/bin/env python3

"""Emit PP-OCRv6 text and bounding boxes as JSON lines for the local eval."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from PIL import Image
from rapidocr import ModelType, OCRVersion, RapidOCR


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tier", choices=("tiny", "small"), required=True)
    parser.add_argument("images", nargs="+")
    return parser.parse_args()


def box_from_quad(quad: object) -> dict[str, int]:
    points = quad.tolist() if hasattr(quad, "tolist") else quad
    xs = [float(point[0]) for point in points]
    ys = [float(point[1]) for point in points]
    x_min = round(min(xs))
    y_min = round(min(ys))
    x_max = round(max(xs))
    y_max = round(max(ys))
    return {
        "x": x_min,
        "y": y_min,
        "width": max(1, x_max - x_min),
        "height": max(1, y_max - y_min),
    }


def main() -> None:
    args = parse_args()
    model_type = ModelType.TINY if args.tier == "tiny" else ModelType.SMALL
    parameters = {
        "Global.log_level": "error",
        "Global.use_cls": False,
        "Det.model_type": model_type,
        "Det.ocr_version": OCRVersion.PPOCRV6,
        "Rec.model_type": model_type,
        "Rec.ocr_version": OCRVersion.PPOCRV6,
    }
    init_started = time.perf_counter()
    engine = RapidOCR(params=parameters)
    initialization_ms = (time.perf_counter() - init_started) * 1000

    for image_name in args.images:
        image_path = Path(image_name).resolve()
        with Image.open(image_path) as image:
            width, height = image.size
        started = time.perf_counter()
        result = engine(str(image_path))
        duration_ms = (time.perf_counter() - started) * 1000
        texts = []
        result_texts = [] if result.txts is None else result.txts
        result_scores = [] if result.scores is None else result.scores
        result_boxes = [] if result.boxes is None else result.boxes
        for text, score, box in zip(result_texts, result_scores, result_boxes):
            texts.append({
                "text": str(text),
                "confidence": float(score),
                "box": box_from_quad(box),
            })
        print(json.dumps({
            "imagePath": str(image_path),
            "tier": args.tier,
            "width": width,
            "height": height,
            "initializationMs": initialization_ms,
            "durationMs": duration_ms,
            "engineElapsedMs": [
                float(value) * 1000
                for value in ([] if result.elapse_list is None else result.elapse_list)
                if value is not None
            ],
            "text": texts,
        }), flush=True)


if __name__ == "__main__":
    main()
