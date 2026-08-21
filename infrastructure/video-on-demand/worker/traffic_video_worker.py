#!/usr/bin/env python3
"""Long-poll the TrafficAtlas video queue and run GPU jobs serially."""

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
QUEUE_URL = os.environ["TRAFFIC_VIDEO_QUEUE_URL"]
TABLE_NAME = os.environ["TRAFFIC_VIDEO_JOBS_TABLE"]
WORK_ROOT = Path(os.getenv("TRAFFIC_WORK_ROOT", "/srv/traffic-video/queue-work"))
APP_ROOT = Path(os.getenv("TRAFFIC_APP_ROOT", "/srv/traffic-video/app"))
TRACK_IMAGE = os.getenv("TRAFFIC_YOLO_IMAGE", "traffic-yolo:cam5-reference")
COUNT_IMAGE = os.getenv("TRAFFIC_COUNT_IMAGE", "traffic-video:ds8-atlas-20260722")
IDLE_TIMEOUT_SECONDS = int(os.getenv("TRAFFIC_IDLE_TIMEOUT_SECONDS", "900"))
FINALIZER = Path(
    os.getenv(
        "TRAFFIC_FINALIZER",
        "/opt/traffic-atlas-worker/finalize-video-job.js",
    )
)

s3 = boto3.client("s3", region_name=REGION)
sqs = boto3.client("sqs", region_name=REGION)
dynamodb = boto3.resource("dynamodb", region_name=REGION).Table(TABLE_NAME)
ec2 = boto3.client("ec2", region_name=REGION)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def update_job(video_id: str, **changes: Any) -> None:
    changes["updatedAt"] = now_iso()
    names = {f"#n{index}": key for index, key in enumerate(changes)}
    values = {f":v{index}": value for index, value in enumerate(changes.values())}
    expression = "SET " + ", ".join(
        f"{name} = {value}"
        for name, value in zip(names.keys(), values.keys(), strict=True)
    )
    dynamodb.update_item(
        Key={"videoId": video_id},
        UpdateExpression=expression,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def run(command: list[str], *, env: dict[str, str] | None = None) -> None:
    subprocess.run(command, check=True, env=env)


def download(bucket: str, key: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    s3.download_file(bucket, key, str(destination))


def upload_tree(bucket: str, output_prefix: str, output_dir: Path) -> None:
    for file_path in output_dir.iterdir():
        if file_path.is_file():
            s3.upload_file(
                str(file_path),
                bucket,
                f"{output_prefix}/{file_path.name}",
                ExtraArgs={"ServerSideEncryption": "AES256"},
            )


def process_tracking(message: dict[str, Any]) -> None:
    video_id = message["videoId"]
    bucket = message["bucket"]
    job_root = WORK_ROOT / video_id
    shutil.rmtree(job_root, ignore_errors=True)
    input_path = job_root / "input" / Path(message["inputKey"]).name
    output_dir = job_root / "output"
    output_dir.mkdir(parents=True, exist_ok=True)
    update_job(
        video_id,
        status="processing",
        countsStatus="awaiting_tracks",
        processingStartedAt=now_iso(),
        workerInstanceId=instance_id(),
        error=None,
    )
    download(bucket, message["inputKey"], input_path)
    env = {
        **os.environ,
        "TRAFFIC_YOLO_IMAGE": TRACK_IMAGE,
        "TRAFFIC_APP_DIR": str(APP_ROOT),
    }
    run(
        [
            str(APP_ROOT / "scripts" / "run-yolo-traffic-job.sh"),
            str(input_path),
            str(output_dir),
        ],
        env=env,
    )
    run(
        [
            "node",
            str(FINALIZER),
            str(WORK_ROOT),
            video_id,
            str(message["width"]),
            str(message["height"]),
        ]
    )
    zones_path = output_dir / "zones.geojson"
    if zones_path.exists() and json.loads(zones_path.read_text())["features"]:
        recount(message, output_dir, zones_path)
    upload_tree(bucket, message["outputPrefix"], output_dir)
    update_job(
        video_id,
        status="ready",
        countsStatus="ready" if (output_dir / "movement_counts.csv").exists() else "not_configured",
        processingCompletedAt=now_iso(),
        countsUpdatedAt=now_iso() if (output_dir / "movement_counts.csv").exists() else None,
        error=None,
    )


def recount(message: dict[str, Any], output_dir: Path, zones_path: Path) -> None:
    env = {
        **os.environ,
        "TRAFFIC_IMAGE": COUNT_IMAGE,
        "TRAFFIC_APP_DIR": str(APP_ROOT),
        "TRAFFIC_COUNT_BIN_SECONDS": str(message.get("binSeconds", 900)),
    }
    run(
        [
            str(APP_ROOT / "scripts" / "run-zone-recount.sh"),
            str(output_dir / "tracks.csv"),
            str(zones_path),
            str(output_dir / "movement_counts.csv"),
        ],
        env=env,
    )


def process_recount(message: dict[str, Any]) -> None:
    video_id = message["videoId"]
    bucket = message["bucket"]
    output_dir = WORK_ROOT / video_id / "output"
    output_dir.mkdir(parents=True, exist_ok=True)
    tracks_path = output_dir / "tracks.csv"
    zones_path = output_dir / "zones.geojson"
    update_job(video_id, countsStatus="calculating", error=None)
    if not tracks_path.exists():
        download(bucket, f"{message['outputPrefix']}/tracks.csv", tracks_path)
    download(bucket, message["zonesKey"], zones_path)
    recount(message, output_dir, zones_path)
    s3.upload_file(
        str(output_dir / "movement_counts.csv"),
        bucket,
        f"{message['outputPrefix']}/movement_counts.csv",
        ExtraArgs={"ServerSideEncryption": "AES256"},
    )
    s3.upload_file(
        str(zones_path),
        bucket,
        f"{message['outputPrefix']}/zones.geojson",
        ExtraArgs={"ServerSideEncryption": "AES256"},
    )
    update_job(video_id, countsStatus="ready", countsUpdatedAt=now_iso(), error=None)


def process_message(raw_message: dict[str, Any]) -> None:
    message = json.loads(raw_message["Body"])
    action = message.get("action")
    if action == "track":
        process_tracking(message)
    elif action == "recount":
        process_recount(message)
    else:
        raise ValueError(f"Unsupported queue action: {action}")


def instance_id() -> str:
    token_request = urllib.request.Request(
        "http://169.254.169.254/latest/api/token",
        method="PUT",
        headers={"X-aws-ec2-metadata-token-ttl-seconds": "21600"},
    )
    with urllib.request.urlopen(token_request, timeout=2) as response:
        token = response.read().decode()
    metadata_request = urllib.request.Request(
        "http://169.254.169.254/latest/meta-data/instance-id",
        headers={"X-aws-ec2-metadata-token": token},
    )
    with urllib.request.urlopen(metadata_request, timeout=2) as response:
        return response.read().decode()


def stop_if_idle(idle_since: float) -> bool:
    if time.monotonic() - idle_since < IDLE_TIMEOUT_SECONDS:
        return False
    attributes = sqs.get_queue_attributes(
        QueueUrl=QUEUE_URL,
        AttributeNames=[
            "ApproximateNumberOfMessages",
            "ApproximateNumberOfMessagesNotVisible",
        ],
    )["Attributes"]
    visible = int(attributes.get("ApproximateNumberOfMessages", "0"))
    in_flight = int(attributes.get("ApproximateNumberOfMessagesNotVisible", "0"))
    if visible or in_flight:
        return False
    ec2.stop_instances(InstanceIds=[instance_id()])
    return True


def main() -> None:
    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    idle_since = time.monotonic()
    while True:
        response = sqs.receive_message(
            QueueUrl=QUEUE_URL,
            MaxNumberOfMessages=1,
            WaitTimeSeconds=20,
            VisibilityTimeout=21600,
            AttributeNames=["ApproximateReceiveCount"],
        )
        messages = response.get("Messages", [])
        if not messages:
            if stop_if_idle(idle_since):
                return
            continue
        idle_since = time.monotonic()
        raw_message = messages[0]
        video_id = "unknown"
        try:
            video_id = json.loads(raw_message["Body"]).get("videoId", "unknown")
            process_message(raw_message)
            sqs.delete_message(
                QueueUrl=QUEUE_URL,
                ReceiptHandle=raw_message["ReceiptHandle"],
            )
            shutil.rmtree(WORK_ROOT / video_id, ignore_errors=True)
        except Exception as error:
            attempt = int(
                raw_message.get("Attributes", {}).get("ApproximateReceiveCount", "1")
            )
            if video_id != "unknown":
                body = json.loads(raw_message["Body"])
                final_attempt = attempt >= 3
                update_job(
                    video_id,
                    status="failed" if final_attempt else "queued",
                    countsStatus=(
                        "failed"
                        if final_attempt
                        else (
                            "queued"
                            if body.get("action") == "recount"
                            else "awaiting_tracks"
                        )
                    ),
                    error=str(error),
                    retryAttempt=attempt,
                )
            sqs.change_message_visibility(
                QueueUrl=QUEUE_URL,
                ReceiptHandle=raw_message["ReceiptHandle"],
                VisibilityTimeout=60,
            )


if __name__ == "__main__":
    main()
