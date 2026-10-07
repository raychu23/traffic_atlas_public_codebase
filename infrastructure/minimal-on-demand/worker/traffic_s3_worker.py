#!/usr/bin/env python3
"""S3-manifest worker for the minimal one-GPU TrafficAtlas deployment.

S3 writes ``control/*.json`` last. The bucket event wakes EC2; this process
claims one manifest at a time, produces artifacts under ``output/``, and stops
the instance after an idle period. It deliberately needs no SQS or DynamoDB.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import boto3


REGION = os.getenv("AWS_REGION", "us-east-1")
BUCKET = os.environ["TRAFFIC_VIDEO_BUCKET"]
PREFIX = os.getenv("TRAFFIC_VIDEO_S3_PREFIX", "traffic-video-jobs").strip("/")
WORK_ROOT = Path(os.getenv("TRAFFIC_WORK_ROOT", "/srv/traffic-video/s3-work"))
APP_ROOT = Path(os.getenv("TRAFFIC_APP_ROOT", "/srv/traffic-video/app"))
FINALIZER = Path(os.getenv("TRAFFIC_FINALIZER", "/opt/traffic-atlas-worker/finalize-video-job.js"))
TRACK_IMAGE = os.getenv("TRAFFIC_YOLO_IMAGE", "traffic-yolo:cam5-reference")
COUNT_IMAGE = os.getenv("TRAFFIC_COUNT_IMAGE", "traffic-video:ds8-atlas-20260722")
IDLE_TIMEOUT_SECONDS = int(os.getenv("TRAFFIC_IDLE_TIMEOUT_SECONDS", "900"))
POLL_SECONDS = int(os.getenv("TRAFFIC_S3_POLL_SECONDS", "15"))

s3 = boto3.client("s3", region_name=REGION)
ec2 = boto3.client("ec2", region_name=REGION)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def job_prefix(video_id: str) -> str:
    return f"{PREFIX}/{video_id}"


def run(command: list[str], env: dict[str, str] | None = None) -> None:
    subprocess.run(command, check=True, env=env)


def put_json(key: str, payload: dict[str, Any]) -> None:
    s3.put_object(
        Bucket=BUCKET,
        Key=key,
        Body=json.dumps(payload, indent=2).encode(),
        ContentType="application/json",
        ServerSideEncryption="AES256",
    )


def write_state(message: dict[str, Any], **changes: Any) -> None:
    video_id = message["videoId"]
    key = f"{job_prefix(video_id)}/state.json"
    try:
        current = json.loads(s3.get_object(Bucket=BUCKET, Key=key)["Body"].read())
    except s3.exceptions.NoSuchKey:
        current = {"videoId": video_id, "bucket": BUCKET}
    current.update(changes)
    current["updatedAt"] = now_iso()
    put_json(key, current)


def download(key: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    s3.download_file(BUCKET, key, str(destination))


def upload_tree(output_prefix: str, directory: Path) -> None:
    for file_path in directory.iterdir():
        if file_path.is_file():
            s3.upload_file(
                str(file_path), BUCKET, f"{output_prefix}/{file_path.name}",
                ExtraArgs={"ServerSideEncryption": "AES256"},
            )


def recount(message: dict[str, Any], output_dir: Path, zones_path: Path) -> None:
    env = {
        **os.environ,
        "TRAFFIC_IMAGE": COUNT_IMAGE,
        "TRAFFIC_APP_DIR": str(APP_ROOT),
        "TRAFFIC_COUNT_BIN_SECONDS": str(message.get("binSeconds", 900)),
    }
    run([
        str(APP_ROOT / "scripts" / "run-zone-recount.sh"),
        str(output_dir / "tracks.csv"), str(zones_path), str(output_dir / "movement_counts.csv"),
    ], env)


def process_tracking(message: dict[str, Any]) -> None:
    video_id = message["videoId"]
    root = WORK_ROOT / video_id
    shutil.rmtree(root, ignore_errors=True)
    input_path = root / "input" / Path(message["inputKey"]).name
    output_dir = root / "output"
    output_dir.mkdir(parents=True, exist_ok=True)
    write_state(message, status="processing", countsStatus="awaiting_tracks", processingStartedAt=now_iso(), error=None)
    download(message["inputKey"], input_path)
    run([
        str(APP_ROOT / "scripts" / "run-yolo-traffic-job.sh"), str(input_path), str(output_dir),
    ], {**os.environ, "TRAFFIC_YOLO_IMAGE": TRACK_IMAGE, "TRAFFIC_APP_DIR": str(APP_ROOT)})
    run(["node", str(FINALIZER), str(WORK_ROOT), video_id, str(message["width"]), str(message["height"])])
    zones_path = root / "zones.geojson"
    if zones_path.exists() and json.loads(zones_path.read_text())["features"]:
        recount(message, output_dir, zones_path)
    upload_tree(message["outputPrefix"], output_dir)
    write_state(
        message, status="ready",
        countsStatus="ready" if (output_dir / "movement_counts.csv").exists() else "not_configured",
        processingCompletedAt=now_iso(), countsUpdatedAt=now_iso(), error=None,
    )


def process_recount(message: dict[str, Any]) -> None:
    video_id = message["videoId"]
    output_dir = WORK_ROOT / video_id / "output"
    output_dir.mkdir(parents=True, exist_ok=True)
    tracks_path = output_dir / "tracks.csv"
    zones_path = output_dir / "zones.geojson"
    write_state(message, countsStatus="calculating", error=None)
    if not tracks_path.exists():
        download(f"{message['outputPrefix']}/tracks.csv", tracks_path)
    download(message["zonesKey"], zones_path)
    recount(message, output_dir, zones_path)
    upload_tree(message["outputPrefix"], output_dir)
    write_state(message, countsStatus="ready", countsUpdatedAt=now_iso(), error=None)


def next_manifest() -> tuple[str, dict[str, Any]] | None:
    pages = s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=f"{PREFIX}/")
    for page in pages:
        candidates = sorted(
            entry["Key"] for entry in page.get("Contents", [])
            if "/control/" in entry["Key"] and entry["Key"].endswith(".json")
        )
        if candidates:
            key = candidates[0]
            return key, json.loads(s3.get_object(Bucket=BUCKET, Key=key)["Body"].read())
    return None


def instance_id() -> str:
    token_request = urllib.request.Request(
        "http://169.254.169.254/latest/api/token", method="PUT",
        headers={"X-aws-ec2-metadata-token-ttl-seconds": "21600"},
    )
    with urllib.request.urlopen(token_request, timeout=2) as response:
        token = response.read().decode()
    request = urllib.request.Request(
        "http://169.254.169.254/latest/meta-data/instance-id",
        headers={"X-aws-ec2-metadata-token": token},
    )
    with urllib.request.urlopen(request, timeout=2) as response:
        return response.read().decode()


def set_lifecycle(worker_id: str, state: str) -> None:
    put_json(f"{PREFIX}/_workers/{worker_id}/lifecycle.json", {
        "instanceId": worker_id, "state": state, "updatedAt": now_iso(),
    })


def stop_if_idle(worker_id: str) -> bool:
    # Publish intent before the final queue scan. Uploads before this write are
    # found by the scan; uploads after it make Lambda retry the wake-up.
    set_lifecycle(worker_id, "stopping")
    if next_manifest() is not None:
        set_lifecycle(worker_id, "active")
        return False
    ec2.stop_instances(InstanceIds=[worker_id])
    return True


def main() -> None:
    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    worker_id = instance_id()
    # Clear stale shutdown intent before consuming jobs on every worker start.
    set_lifecycle(worker_id, "active")
    idle_since = time.monotonic()
    while True:
        item = next_manifest()
        if item is None:
            if time.monotonic() - idle_since >= IDLE_TIMEOUT_SECONDS:
                if stop_if_idle(worker_id):
                    return
                idle_since = time.monotonic()
                continue
            time.sleep(POLL_SECONDS)
            continue
        idle_since = time.monotonic()
        key, message = item
        try:
            if message.get("action") == "track":
                process_tracking(message)
            elif message.get("action") == "recount":
                process_recount(message)
            else:
                raise ValueError(f"Unsupported action: {message.get('action')}")
            s3.delete_object(Bucket=BUCKET, Key=key)
        except Exception as error:
            write_state(message, status="failed", countsStatus="failed", error=str(error))
            s3.delete_object(Bucket=BUCKET, Key=key)


if __name__ == "__main__":
    main()
