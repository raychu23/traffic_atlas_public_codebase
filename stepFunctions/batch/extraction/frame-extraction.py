#!/usr/bin/env python3
import os
import json
import zipfile
import subprocess
import boto3
import random
from pathlib import Path
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed


aws_access_key = os.environ.get("AWS_ACCESS_KEY_ID")
aws_secret_key = os.environ.get("AWS_SECRET_ACCESS_KEY")

s3 = boto3.client(
    "s3",
    aws_access_key_id=aws_access_key,
    aws_secret_access_key=aws_secret_key
)


def get_analysis_prefix(output_prefix: str) -> str:
    return output_prefix.rstrip("/").rsplit("/frames", 1)[0]


def write_processing_status(bucket, analysis_prefix, status_payload):
    """
    Writes dataset-level processing status JSON to S3.
    This replaces DynamoDB for MVP status tracking.
    """
    status_key = f"{analysis_prefix}/status/processing_status.json"

    s3.put_object(
        Bucket=bucket,
        Key=status_key,
        Body=json.dumps(status_payload, indent=2),
        ContentType="application/json"
    )

    print(f"Processing status updated: s3://{bucket}/{status_key}")
    return status_key

def find_zip_in_prefix(bucket: str, zip_prefix: str) -> str:
    clean_prefix = zip_prefix.strip("/")

    paginator = s3.get_paginator("list_objects_v2")
    pages = paginator.paginate(
        Bucket=bucket,
        Prefix=clean_prefix + "/"
    )

    zip_files = []

    for page in pages:
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if key.lower().endswith(".zip"):
                zip_files.append({
                    "Key": key,
                    "LastModified": obj["LastModified"],
                    "Size": obj["Size"]
                })

    if not zip_files:
        raise ValueError(f"No .zip file found under prefix: {clean_prefix}/")

    zip_files = sorted(zip_files, key=lambda x: x["LastModified"], reverse=True)

    if len(zip_files) > 1:
        print("WARNING: Multiple zip files found. Using most recent:")
        for z in zip_files:
            print(f"  {z['Key']} | size={z['Size']} | modified={z['LastModified']}")

    return zip_files[0]["Key"]

def get_video_duration(video_file):
    cmd = [
        "ffprobe",
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        video_file
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)

    try:
        return float(result.stdout.strip())
    except:
        return None


def stratified_random_timestamps(start_sec, end_sec, n_samples):
    if n_samples <= 0 or end_sec <= start_sec:
        return []

    interval = (end_sec - start_sec) / n_samples
    timestamps = []

    for i in range(n_samples):
        a = start_sec + i * interval
        b = min(start_sec + (i + 1) * interval, end_sec)
        timestamps.append(random.uniform(a, b))

    return timestamps


def generate_timestamps(duration_sec):
    if duration_sec is None or duration_sec <= 0:
        return []

    if duration_sec <= 120:
        return sorted(stratified_random_timestamps(0, duration_sec, 40))

    elif duration_sec <= 600:
        return sorted(stratified_random_timestamps(0, duration_sec, 100))

    else:
        chunk_size = 600
        timestamps = []

        num_chunks = int((duration_sec + chunk_size - 1) // chunk_size)

        for i in range(num_chunks):
            start = i * chunk_size
            end = min((i + 1) * chunk_size, duration_sec)
            timestamps.extend(stratified_random_timestamps(start, end, 50))

        return sorted(timestamps[:400])

def extract_single_frame(video_file, ts, output_path):
    cmd = [
        "ffmpeg",
        "-y",
        "-ss", str(ts),
        "-i", video_file,
        "-frames:v", "1",
        "-vf", "format=rgb24",
        output_path
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    return result.returncode == 0


def process_video(video_file, extract_dir, output_prefix, bucket, ffmpeg_threads, dataset_id):
    video_name = Path(video_file).stem
    print(f"Processing video: {video_name}")

    frames_dir = os.path.join(extract_dir, "frames", video_name)
    os.makedirs(frames_dir, exist_ok=True)

    duration = get_video_duration(video_file)

    if duration is None:
        print(f"Could not determine duration for {video_name}")
        return {"video_name": video_name, "status": "failed", "frames_extracted": 0}

    timestamps = generate_timestamps(duration)

    print(f"{video_name}: sampling {len(timestamps)} frames from {duration:.2f}s")

    frame_metadata = []

    # Parallel extraction 
    with ThreadPoolExecutor(max_workers=ffmpeg_threads) as executor:
        futures = []

        for i, ts in enumerate(timestamps):
            frame_name = f"frame_{i:06d}.png"
            output_path = os.path.join(frames_dir, frame_name)

            futures.append(
                executor.submit(extract_single_frame, video_file, ts, output_path)
            )

            frame_metadata.append({
                "frame_name": frame_name,
                "timestamp_sec": ts,
                "frame_format": "png",
                "dataset_id": dataset_id,
                "video_name": video_name
            })

        results = [f.result() for f in futures]

    success_count = sum(results)
    
    frame_metadata = [
    meta for meta, ok in zip(frame_metadata, results)
    if ok
    ]

    frame_files = sorted([
        f for f in os.listdir(frames_dir)
        if f.lower().endswith(".png")
    ])

    print(f"{video_name}: extracted {success_count}/{len(timestamps)} frames")

    # Upload frames
    for i, frame_file in enumerate(frame_files):
        if i % 50 == 0:
            print(f"{video_name}: uploading {i}/{len(frame_files)}")

        local_frame = os.path.join(frames_dir, frame_file)
        s3_frame_key = f"{output_prefix}/{video_name}/{frame_file}"
        s3.upload_file(local_frame, bucket, s3_frame_key)

    # Save sampling metadata
    metadata_key = f"{output_prefix}/{video_name}/frame_sampling_metadata.json"

    s3.put_object(
        Bucket=bucket,
        Key=metadata_key,
        Body=json.dumps({
            "video_name": video_name,
            "duration_sec": duration,
            "frames_requested": len(timestamps),
            "frames_extracted": success_count,
            "sampling_strategy": "adaptive_random_chunked",
            "frame_format": "png",
            "frames_s3_prefix": f"s3://{bucket}/{output_prefix}/{video_name}/",
            "frames": frame_metadata
        }, indent=2),
        ContentType="application/json"
    )

    return {
        "video_name": video_name,
        "status": "success",
        "frames_extracted": success_count
    }

def main():
    dataset_id = os.environ.get("DATASET_ID")
    bucket = os.environ.get("BUCKET")
    zip_key = os.environ.get("ZIP_KEY")
    zip_prefix = os.environ.get("ZIP_PREFIX")
    output_prefix = os.environ.get("OUTPUT_PREFIX", "").rstrip("/")

    max_workers = int(os.environ.get("MAX_WORKERS", "4"))
    ffmpeg_threads = int(os.environ.get("FFMPEG_THREADS", "2"))

    if not all([dataset_id, bucket, output_prefix]):
        raise ValueError(
            "Missing required env vars: DATASET_ID, BUCKET, OUTPUT_PREFIX"
        )
    if not zip_key and not zip_prefix:
        raise ValueError("Provide either ZIP_KEY or ZIP_PREFIX")
        
    analysis_prefix = get_analysis_prefix(output_prefix)
    if not zip_key:
        zip_key = find_zip_in_prefix(bucket, zip_prefix)

    print(f"Starting frame extraction for dataset: {dataset_id}")
    print(f"Zip location: s3://{bucket}/{zip_key}")
    print(f"Output prefix: s3://{bucket}/{output_prefix}")
    print(f"MAX_WORKERS={max_workers}, FFMPEG_THREADS={ffmpeg_threads}")

    extraction_log = {
        "dataset_id": dataset_id,
        "started_at": datetime.utcnow().isoformat(),
        "videos_found": 0,
        "videos": [],
        "max_workers": max_workers,
        "ffmpeg_threads": ffmpeg_threads
    }


    # Write initial status file for this AWS Batch job
    write_processing_status(bucket, analysis_prefix, {
        "dataset_id": dataset_id,
        "overall_status": "processing",
        "current_stage": "frame_extraction_running",
        "updated_at": datetime.utcnow().isoformat(),
        "steps": {
            "frame_extraction": {
                "status": "running",
                "started_at": extraction_log["started_at"],
                "zip_key": zip_key,
                "frames_prefix": output_prefix,
                "frame_format": "png"
            },
            "embedding_generation": {"status": "pending"},
            "tagging_input": {"status": "pending"},
            "bedrock_batch": {"status": "pending"},
            "tag_parsing": {"status": "pending"},
            "dataset_summary": {"status": "pending"}
        }
    })

    try:
        local_zip = f"/tmp/{dataset_id}_sample.zip"
        print("Downloading zip file...")
        s3.download_file(bucket, zip_key, local_zip)

        extract_dir = f"/tmp/{dataset_id}_extracted"
        os.makedirs(extract_dir, exist_ok=True)

        print("Extracting zip...")
        with zipfile.ZipFile(local_zip, "r") as zip_ref:
            zip_ref.extractall(extract_dir)

        video_extensions = {
            ".mp4", ".avi", ".mov", ".mkv", ".flv", ".wmv", ".webm",
            ".mts", ".m4v", ".mpeg", ".mpg", ".3gp"
        }

        video_files = []
        for root, _, files in os.walk(extract_dir):
            for file in files:
                if Path(file).suffix.lower() in video_extensions:
                    video_files.append(os.path.join(root, file))

        extraction_log["videos_found"] = len(video_files)
        print(f"Found {len(video_files)} video files")

        if not video_files:
            print("No video files found. Writing log only.")

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = [
                executor.submit(
                    process_video,
                    video_file,
                    extract_dir,
                    output_prefix,
                    bucket,
                    ffmpeg_threads,
                    dataset_id
                )
                for video_file in video_files
            ]

            for future in as_completed(futures):
                result = future.result()
                extraction_log["videos"].append(result)
                print(
                    f"Finished {result['video_name']}: "
                    f"{result['status']} "
                    f"({result.get('frames_extracted', 0)} frames)"
                )

        extraction_log["completed_at"] = datetime.utcnow().isoformat()
        extraction_log["total_frames_extracted"] = sum(
            v.get("frames_extracted", 0)
            for v in extraction_log["videos"]
        )
        extraction_log["status"] = "success"

        log_key = f"{analysis_prefix}/logs/extraction_log.json"

        s3.put_object(
            Bucket=bucket,
            Key=log_key,
            Body=json.dumps(extraction_log, indent=2),
            ContentType="application/json"
        )


        status_key = write_processing_status(bucket, analysis_prefix, {
            "dataset_id": dataset_id,
            "overall_status": "processing",
            "current_stage": "frame_extraction_completed",
            "updated_at": datetime.utcnow().isoformat(),
            "steps": {
                "frame_extraction": {
                    "status": "completed",
                    "started_at": extraction_log["started_at"],
                    "completed_at": extraction_log["completed_at"],
                    "zip_key": zip_key,
                    "frames_prefix": output_prefix,
                    "frames_s3_uri": f"s3://{bucket}/{output_prefix}/",
                    "frame_format": "png",
                    "videos_found": extraction_log["videos_found"],
                    "total_frames_extracted": extraction_log["total_frames_extracted"],
                    "extraction_log_key": log_key
                },
                "embedding_generation": {"status": "pending"},
                "tagging_input": {"status": "pending"},
                "bedrock_batch": {"status": "pending"},
                "tag_parsing": {"status": "pending"},
                "dataset_summary": {"status": "pending"}
            }
        })

        print("Frame extraction complete.")
        print(f"Total frames extracted and uploaded: {extraction_log['total_frames_extracted']}")
        print(f"Log: s3://{bucket}/{log_key}")

    except Exception as e:
        print(f"ERROR: {str(e)}")

        error_log = {
            "dataset_id": dataset_id,
            "error": str(e),
            "timestamp": datetime.utcnow().isoformat()
        }

        error_key = f"{analysis_prefix}/logs/extraction_error.json"

        s3.put_object(
            Bucket=bucket,
            Key=error_key,
            Body=json.dumps(error_log, indent=2),
            ContentType="application/json"
        )


        write_processing_status(bucket, analysis_prefix, {
            "dataset_id": dataset_id,
            "overall_status": "failed",
            "current_stage": "frame_extraction_failed",
            "updated_at": datetime.utcnow().isoformat(),
            "steps": {
                "frame_extraction": {
                    "status": "failed",
                    "error": str(e),
                    "error_log_key": error_key
                },
                "embedding_generation": {"status": "pending"},
                "tagging_input": {"status": "pending"},
                "bedrock_batch": {"status": "pending"},
                "tag_parsing": {"status": "pending"},
                "dataset_summary": {"status": "pending"}
            }
        })

        raise


if __name__ == "__main__":
    main()
