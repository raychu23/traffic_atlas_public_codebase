import json
import base64
import boto3
from datetime import datetime, timezone

REGION = "us-east-1"

s3 = boto3.client("s3", region_name=REGION)

def now_iso():
    return datetime.now(timezone.utc).isoformat()

def put_text_to_s3(bucket, key, text, content_type="text/plain"):
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=text.encode("utf-8"),
        ContentType=content_type,
        ServerSideEncryption="AES256"
    )

def put_json_to_s3(bucket, key, data):
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(data, indent=2).encode("utf-8"),
        ContentType="application/json",
        ServerSideEncryption="AES256"
    )

def list_png_frames(bucket, frames_prefix):
    frames = []
    continuation_token = None
    prefix = frames_prefix.rstrip("/") + "/"

    while True:
        params = {
            "Bucket": bucket,
            "Prefix": prefix,
            "MaxKeys": 1000
        }

        if continuation_token:
            params["ContinuationToken"] = continuation_token

        response = s3.list_objects_v2(**params)

        for obj in response.get("Contents", []):
            key = obj["Key"]

            if not key.lower().endswith(".png"):
                continue

            relative_path = key.replace(prefix, "", 1)
            parts = [p for p in relative_path.split("/") if p]

            if len(parts) < 2:
                continue

            video_name = parts[0]
            frame_name = parts[1]
            frame_stem = frame_name.rsplit(".", 1)[0]

            frames.append({
                "video_name": video_name,
                "frame_name": frame_name,
                "frame_stem": frame_stem,
                "frame_key": key,
                "frame_s3_uri": f"s3://{bucket}/{key}"
            })

        if response.get("IsTruncated"):
            continuation_token = response.get("NextContinuationToken")
        else:
            break

    return sorted(frames, key=lambda x: (x["video_name"], x["frame_name"]))

def lambda_handler(event, context):
    print("PrepareBase64Frames event:")
    print(json.dumps(event, indent=2))

    dataset_id = event.get("dataset_id")
    bucket = event.get("bucket")
    frames_prefix = event.get("frames_prefix")

    if not dataset_id or not bucket or not frames_prefix:
        raise Exception("Missing required input: dataset_id, bucket, or frames_prefix")

    dataset_root_prefix = event.get(
        "dataset_root_prefix",
        f"traffic-atlas/datasets/{dataset_id}/"
    )

    base_prefix = f"{dataset_root_prefix.rstrip('/')}/analysis"

    bedrock_prefix = f"{base_prefix}/bedrock"
    frame_base64_prefix = f"{bedrock_prefix}/frame_base64"

    # We just keep the manifest key, no jsonl key needed
    manifest_key = f"{bedrock_prefix}/manifest/tagging_manifest.json"

    frames = list_png_frames(bucket, frames_prefix)

    if not frames:
        raise Exception(f"No PNG frames found under prefix: {frames_prefix}")

    manifest = {
        "dataset_id": dataset_id,
        "bucket": bucket,
        "frames_prefix": frames_prefix,
        "frame_base64_prefix": frame_base64_prefix,
        "created_at": now_iso(),
        "total_frames": len(frames),
        "records": {}
    }

    for frame in frames:
        record_id = f"{frame['video_name']}__{frame['frame_stem']}"

        # 1. Fetch the image
        obj = s3.get_object(
            Bucket=bucket,
            Key=frame["frame_key"]
        )

        # 2. Convert to Base64
        image_bytes = obj["Body"].read()
        image_base64 = base64.b64encode(image_bytes).decode("utf-8")

        frame_base64_key = (
            f"{frame_base64_prefix}/"
            f"{frame['video_name']}/{frame['frame_stem']}.base64.txt"
        )

        # 3. Save ONLY the base64 text file
        put_text_to_s3(
            bucket=bucket,
            key=frame_base64_key,
            text=image_base64,
            content_type="text/plain"
        )

        # 4. Update the manifest record
        manifest["records"][record_id] = {
            **frame,
            "recordId": record_id,
            "frame_base64_key": frame_base64_key,
            "frame_base64_s3_uri": f"s3://{bucket}/{frame_base64_key}"
        }

    # Save the manifest summarizing where all the base64 files are
    put_json_to_s3(
        bucket=bucket,
        key=manifest_key,
        data=manifest
    )

    return {
        "success": True,
        "dataset_id": dataset_id,
        "bucket": bucket,
        "total_frames": len(frames),
        "frame_base64_prefix": frame_base64_prefix,
        "manifest_key": manifest_key,
        "tagging_manifest_key": manifest_key,
        "tagging_input_key": f"{frame_base64_prefix}/tagging_input.jsonl",
        "tagging_input_s3_uri": f"s3://{bucket}/{frame_base64_prefix}/"
        }