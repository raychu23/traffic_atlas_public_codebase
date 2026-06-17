#!/usr/bin/env python3
import os
import io
import json
import tempfile
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Any

import boto3
import numpy as np
import torch
from PIL import Image
from transformers import CLIPProcessor, CLIPModel


MODEL_NAME = "openai/clip-vit-base-patch32"


def get_s3_client():
    return boto3.client(
        "s3",
        aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
    )


def get_analysis_prefix(output_prefix: str) -> str:
    return output_prefix.rstrip("/").rsplit("/embeddings", 1)[0]


def load_model(device: str):
    model = CLIPModel.from_pretrained(MODEL_NAME, use_safetensors=True)
    processor = CLIPProcessor.from_pretrained(MODEL_NAME)
    model.eval()
    model.to(device)
    return model, processor


def list_frames(s3, bucket: str, frames_prefix: str) -> Dict[str, List[Dict[str, str]]]:
    frames_by_video: Dict[str, List[Dict[str, str]]] = {}
    continuation_token = None

    while True:
        list_params = {
            "Bucket": bucket,
            "Prefix": frames_prefix.rstrip("/") + "/",
            "MaxKeys": 1000,
        }

        if continuation_token:
            list_params["ContinuationToken"] = continuation_token

        response = s3.list_objects_v2(**list_params)

        for obj in response.get("Contents", []):
            key = obj["Key"]

            if not key.lower().endswith((".jpg", ".jpeg", ".png")):
                continue

            relative_key = key.replace(frames_prefix.rstrip("/") + "/", "", 1)
            parts = relative_key.split("/")

            if len(parts) < 2:
                print(f"Skipping unexpected frame key: {key}")
                continue

            video_name = parts[0]
            frame_name = parts[-1]

            frames_by_video.setdefault(video_name, []).append(
                {
                    "video_name": video_name,
                    "frame_name": frame_name,
                    "frame_s3_key": key,
                }
            )

        if response.get("IsTruncated"):
            continuation_token = response.get("NextContinuationToken")
        else:
            break

    for video_name in frames_by_video:
        frames_by_video[video_name] = sorted(
            frames_by_video[video_name],
            key=lambda x: x["frame_name"]
        )

    return frames_by_video


def download_image(s3, bucket: str, key: str) -> Image.Image:
    obj = s3.get_object(Bucket=bucket, Key=key)
    return Image.open(io.BytesIO(obj["Body"].read())).convert("RGB")


def upload_json(s3, bucket: str, key: str, payload: Any):
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(payload, indent=2),
        ContentType="application/json",
    )


def read_json_from_s3(s3, bucket: str, key: str) -> Dict[str, Any]:
    try:
        obj = s3.get_object(Bucket=bucket, Key=key)
        return json.loads(obj["Body"].read().decode("utf-8"))
    except s3.exceptions.NoSuchKey:
        return {}
    except Exception as e:
        if "NoSuchKey" in str(e):
            return {}
        raise


def update_processing_status(s3, bucket: str, status_key: str, updates: Dict[str, Any]):
    existing = read_json_from_s3(s3, bucket, status_key)

    existing["dataset_id"] = updates.get("dataset_id", existing.get("dataset_id"))
    existing["overall_status"] = updates.get("overall_status", existing.get("overall_status", "processing"))
    existing["current_stage"] = updates.get("current_stage", existing.get("current_stage"))
    existing["updated_at"] = datetime.utcnow().isoformat()

    existing_steps = existing.get("steps", {})
    update_steps = updates.get("steps", {})
    existing_steps.update(update_steps)
    existing["steps"] = existing_steps

    upload_json(s3, bucket, status_key, existing)


def upload_npy(s3, bucket: str, key: str, array: np.ndarray):
    buffer = io.BytesIO()
    np.save(buffer, array)
    buffer.seek(0)

    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=buffer.getvalue(),
        ContentType="application/octet-stream",
    )


def process_video(
    s3,
    bucket: str,
    dataset_id: str,
    video_name: str,
    frames: List[Dict[str, str]],
    output_prefix: str,
    model,
    processor,
    device: str,
    batch_size: int,
) -> Dict[str, Any]:
    print(f"Processing video: {video_name} ({len(frames)} frames)")

    embeddings: List[np.ndarray] = []
    frame_metadata: List[Dict[str, Any]] = []
    errors: List[Dict[str, str]] = []

    for start_idx in range(0, len(frames), batch_size):
        batch_frames = frames[start_idx:start_idx + batch_size]
        images = []
        valid_items = []

        for frame in batch_frames:
            try:
                image = download_image(s3, bucket, frame["frame_s3_key"])
                images.append(image)
                valid_items.append(frame)
            except Exception as e:
                errors.append(
                    {
                        "frame_name": frame["frame_name"],
                        "frame_s3_key": frame["frame_s3_key"],
                        "error": str(e),
                    }
                )

        if not images:
            continue

        with torch.no_grad():
            inputs = processor(images=images, return_tensors="pt", padding=True).to(device)
            image_features = model.get_image_features(**inputs)

            if hasattr(image_features, "pooler_output"):
                image_features = image_features.pooler_output

            image_features = image_features.detach()
            image_features = image_features / image_features.norm(dim=-1, keepdim=True)
            batch_embeddings = image_features.cpu().numpy().astype("float32")

        for row_offset, frame in enumerate(valid_items):
            global_row_index = len(embeddings)
            embeddings.append(batch_embeddings[row_offset])

            frame_stem = Path(frame["frame_name"]).stem

            frame_metadata.append(
                {
                    "dataset_id": dataset_id,
                    "video_name": video_name,
                    "frame_name": frame["frame_name"],
                    "frame_stem": frame_stem,
                    "frame_s3_key": frame["frame_s3_key"],
                    "embedding_file": f"{video_name}_clip_embeddings.npy",
                    "embedding_s3_key": f"{output_prefix}/{video_name}/{video_name}_clip_embeddings.npy",
                    "embedding_row_index": global_row_index,
                    "embedding_model": MODEL_NAME,
                    "embedding_dim": int(batch_embeddings.shape[1]),
                    "embedding_dtype": "float32",
                }
            )

        print(
            f"{video_name}: processed "
            f"{min(start_idx + batch_size, len(frames))}/{len(frames)} frames"
        )

    if embeddings:
        embeddings_array = np.vstack(embeddings).astype("float32")
    else:
        embeddings_array = np.empty((0, 512), dtype="float32")

    video_output_prefix = f"{output_prefix}/{video_name}"

    embeddings_key = f"{video_output_prefix}/{video_name}_clip_embeddings.npy"
    metadata_key = f"{video_output_prefix}/{video_name}_clip_embedding_metadata.json"

    upload_npy(s3, bucket, embeddings_key, embeddings_array)
    upload_json(s3, bucket, metadata_key, frame_metadata)

    video_summary = {
        "dataset_id": dataset_id,
        "video_name": video_name,
        "frames_found": len(frames),
        "frames_embedded": int(embeddings_array.shape[0]),
        "frames_failed": len(errors),
        "embedding_file": f"{video_name}_clip_embeddings.npy",
        "embedding_s3_key": embeddings_key,
        "metadata_s3_key": metadata_key,
        "embedding_shape": list(embeddings_array.shape),
        "embedding_model": MODEL_NAME,
        "embedding_dtype": "float32",
        "errors": errors,
        "generated_at": datetime.utcnow().isoformat(),
    }

    summary_key = f"{video_output_prefix}/{video_name}_clip_embedding_summary.json"
    upload_json(s3, bucket, summary_key, video_summary)

    return video_summary


def main():
    dataset_id = os.environ.get("DATASET_ID")
    bucket = os.environ.get("BUCKET")
    frames_prefix = os.environ.get("FRAMES_PREFIX", "").rstrip("/")
    output_prefix = os.environ.get("OUTPUT_PREFIX", "").rstrip("/")
    batch_size = int(os.environ.get("BATCH_SIZE", "64"))

    if not all([dataset_id, bucket, frames_prefix, output_prefix]):
        raise ValueError(
            "Missing required env vars: DATASET_ID, BUCKET, FRAMES_PREFIX, OUTPUT_PREFIX"
        )

    analysis_prefix = get_analysis_prefix(output_prefix)
    s3 = get_s3_client()

    started_at = datetime.utcnow().isoformat()
    
    status_key = f"{analysis_prefix}/status/processing_status.json"

    update_processing_status(s3, bucket, status_key, {
	    "dataset_id": dataset_id,
	    "overall_status": "processing",
	    "current_stage": "embedding_generation_running",
	    "steps": {
		"embedding_generation": {
		    "status": "running",
		    "started_at": started_at,
		    "frames_prefix": frames_prefix,
		    "output_prefix": output_prefix,
		    "embedding_model": MODEL_NAME
	        }
            }
     })

    print(f"Starting CLIP embedding generation for dataset: {dataset_id}")
    print(f"Frames location: s3://{bucket}/{frames_prefix}")
    print(f"Output location: s3://{bucket}/{output_prefix}")
    print(f"Batch size: {batch_size}")

    try:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"Using device: {device}")

        if device == "cuda":
            print(f"GPU name: {torch.cuda.get_device_name(0)}")
            print(f"CUDA version: {torch.version.cuda}")

        print("Loading CLIP model...")
        model, processor = load_model(device)

        print("Listing frames...")
        frames_by_video = list_frames(s3, bucket, frames_prefix)

        total_frames_found = sum(len(v) for v in frames_by_video.values())
        print(f"Found {total_frames_found} frames across {len(frames_by_video)} videos")

        video_summaries = []
        total_frames_embedded = 0
        total_frames_failed = 0

        for video_name, frames in frames_by_video.items():
            summary = process_video(
                s3=s3,
                bucket=bucket,
                dataset_id=dataset_id,
                video_name=video_name,
                frames=frames,
                output_prefix=output_prefix,
                model=model,
                processor=processor,
                device=device,
                batch_size=batch_size,
            )

            video_summaries.append(summary)
            total_frames_embedded += summary["frames_embedded"]
            total_frames_failed += summary["frames_failed"]

        dataset_manifest = {
            "dataset_id": dataset_id,
            "embedding_model": MODEL_NAME,
            "device": device,
            "batch_size": batch_size,
            "frames_prefix": frames_prefix,
            "output_prefix": output_prefix,
            "total_videos": len(video_summaries),
            "total_frames_found": total_frames_found,
            "total_frames_embedded": total_frames_embedded,
            "total_frames_failed": total_frames_failed,
            "videos": video_summaries,
            "started_at": started_at,
            "completed_at": datetime.utcnow().isoformat(),
            "status": "success",
        }

        manifest_key = f"{output_prefix}/dataset_clip_embedding_manifest.json"
        log_key = f"{analysis_prefix}/logs/embedding_log.json"

        upload_json(s3, bucket, manifest_key, dataset_manifest)
        upload_json(s3, bucket, log_key, dataset_manifest)
        
        update_processing_status(s3, bucket, status_key, {
	    "dataset_id": dataset_id,
	    "overall_status": "processing",
	    "current_stage": "embedding_generation_completed",
	    "steps": {
		"embedding_generation": {
		    "status": "completed",
		    "started_at": started_at,
		    "completed_at": dataset_manifest["completed_at"],
		    "frames_prefix": frames_prefix,
		    "output_prefix": output_prefix,
		    "manifest_key": manifest_key,
		    "log_key": log_key,
		    "total_videos": len(video_summaries),
		    "total_frames_found": total_frames_found,
		    "total_frames_embedded": total_frames_embedded,
		    "total_frames_failed": total_frames_failed,
		    "embedding_model": MODEL_NAME
		}
	    }
	})

        print("Embedding generation complete.")
        print(f"Total frames embedded: {total_frames_embedded}")
        print(f"Manifest: s3://{bucket}/{manifest_key}")
        print(f"Log: s3://{bucket}/{log_key}")

    except Exception as e:
        print(f"ERROR: {e}")

        error_log = {
            "dataset_id": dataset_id,
            "error": str(e),
            "timestamp": datetime.utcnow().isoformat(),
            "status": "failed",
        }

        error_key = f"{analysis_prefix}/logs/embedding_error.json"
        upload_json(s3, bucket, error_key, error_log)
        update_processing_status(s3, bucket, status_key, {
	    "dataset_id": dataset_id,
	    "overall_status": "failed",
	    "current_stage": "embedding_generation_failed",
	    "steps": {
		"embedding_generation": {
		    "status": "failed",
		    "error": str(e),
		    "error_log_key": error_key,
		    "failed_at": datetime.utcnow().isoformat()
		}
	    }
	})

        raise


if __name__ == "__main__":
    main()
