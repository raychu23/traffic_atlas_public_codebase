import json
import os
import time
import boto3
from datetime import datetime, timezone
from botocore.exceptions import ClientError


REGION = "us-east-1"
CLIENT_BUCKET_OWNER = os.environ.get("CLIENT_BUCKET_OWNER")

s3 = boto3.client("s3", region_name=REGION)
bedrock = boto3.client("bedrock", region_name=REGION)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def read_existing_status(bucket, status_key):
    try:
        obj = s3.get_object(Bucket=bucket, Key=status_key)
        body = obj["Body"].read().decode("utf-8")
        return json.loads(body)

    except ClientError as err:
        code = err.response.get("Error", {}).get("Code")
        status_code = err.response.get("ResponseMetadata", {}).get("HTTPStatusCode")

        if code in ["NoSuchKey", "404", "NotFound"] or status_code == 404:
            return {}

        raise


def lambda_handler(event, context):
    print("StartBedrockTagging event:")
    print(json.dumps(event, indent=2))

    dataset_id = event.get("dataset_id")
    bucket = event.get("bucket")
    frames_prefix = event.get("frames_prefix")
    model_id = event.get("model_id")
    bedrock_role_arn = event.get("bedrock_role_arn")

    if not dataset_id or not bucket or not frames_prefix or not model_id or not bedrock_role_arn:
        raise Exception("Missing required input")

    dataset_root_prefix = event.get(
        "dataset_root_prefix",
        f"traffic-atlas/datasets/{dataset_id}/"
    )

    base_prefix = f"{dataset_root_prefix.rstrip('/')}/analysis"

    tagging_input_key = f"{base_prefix}/bedrock/frame_base64/tagging_input.jsonl"
    tagging_manifest_key = f"{base_prefix}/bedrock/manifest/tagging_manifest.json"
    status_key = f"{base_prefix}/status/processing_status.json"

    tagging_input_s3_uri = f"s3://{bucket}/{base_prefix}/bedrock/frame_base64/"
    bedrock_output_s3_uri = f"s3://{bucket}/{base_prefix}/bedrock/output/"

    try:
        # -----------------------------
        # 1. List existing base64 frame files
        # -----------------------------
        base64_prefix = f"{base_prefix}/bedrock/frame_base64/"
        base64_frames = []
        total_frames = 0
        continuation_token = None

        while True:
            params = {
                "Bucket": bucket,
                "Prefix": base64_prefix
            }

            if continuation_token:
                params["ContinuationToken"] = continuation_token

            response = s3.list_objects_v2(**params)

            for obj in response.get("Contents", []):
                key = obj["Key"]
                key_lower = key.lower()

                if not key_lower.endswith(".base64.txt"):
                    continue

                relative_path = key.replace(base64_prefix, "", 1)
                parts = [p for p in relative_path.split("/") if p]

                if len(parts) < 2:
                    continue

                video_name = parts[0]
                base64_name = parts[1]
                frame_stem = base64_name.replace(".base64.txt", "")
                frame_name = f"{frame_stem}.png"

                base64_frames.append({
                    "video_name": video_name,
                    "frame_name": frame_name,
                    "frame_stem": frame_stem,
                    "base64_key": key,
                    "base64_s3_uri": f"s3://{bucket}/{key}"
                })

                total_frames += 1

            if response.get("IsTruncated"):
                continuation_token = response.get("NextContinuationToken")
            else:
                break

        if total_frames == 0:
            raise Exception(f"No base64 frame files found under prefix: {base64_prefix}")

        base64_frames.sort(key=lambda x: (x["video_name"], x["frame_name"]))

        # -----------------------------
        # 2. Build JSONL + manifest
        # -----------------------------
        jsonl_lines = []

        tagging_manifest = {
            "dataset_id": dataset_id,
            "bucket": bucket,
            "frames_prefix": frames_prefix,
            "created_at": now_iso(),
            "total_frames": total_frames,
            "records": {}
        }

        # Central prompt: edit this later if you want to tune the tagging behavior.
        tagging_prompt = """
You are analyzing traffic video frames for a searchable transportation video dataset.

Return ONLY valid JSON. Do not include markdown, explanations, or code fences.

Use the following JSON keys exactly:
{
  "lighting": "",
  "weather": "",
  "road_type": "",
  "traffic_density": "",
  "vehicle_presence": "",
  "pedestrian_presence": "",
  "cyclist_presence": "",
  "truck_presence": "",
  "bus_presence": "",
  "motorcycle_presence": "",
  "emergency_vehicle_presence": "",
  "short_description": ""
}

Use short lowercase labels with underscores.

Guidance for values:
- lighting: daytime, nighttime, dawn_dusk, indoor, unknown
- weather: clear, cloudy, rain, snow, fog, wet_road, unknown
- road_type: freeway, highway, arterial, local_road, intersection, ramp, parking_area, work_zone, unknown
- traffic_density: empty, low, medium, high, congested, unknown
- vehicle_presence: present, absent, unknown
- pedestrian_presence: present, absent, unknown
- cyclist_presence: present, absent, unknown
- truck_presence: present, absent, unknown
- bus_presence: present, absent, unknown
- motorcycle_presence: present, absent, unknown
- emergency_vehicle_presence: present, absent, unknown
- short_description: one concise sentence describing the visible road scene.

Important:
- Prefer a reasonable visible label instead of "unknown" when there is enough visual evidence.
- Use "unknown" only when the frame is too unclear, blocked, dark, blurry, or the category cannot be visually determined.
- Do not invent objects that are not visible.
"""

        for frame in base64_frames:
                record_id = f"{frame['video_name']}__{frame['frame_stem']}"

                base64_obj = s3.get_object(
                    Bucket=bucket,
                    Key=frame["base64_key"]
                )

                image_base64 = base64_obj["Body"].read().decode("utf-8").strip()

                jsonl_record = {
                    "recordId": record_id,
                    "modelInput": {
                        "anthropic_version": "bedrock-2023-05-31",
                        "max_tokens": 700,
                        "temperature": 0,
                        "messages": [
                            {
                                "role": "user",
                                "content": [
                                    {
                                        "type": "text",
                                        "text": tagging_prompt
                                    },
                                    {
                                        "type": "image",
                                        "source": {
                                            "type": "base64",
                                            "media_type": "image/png",
                                            "data": image_base64
                                        }
                                    }
                                                                    ]
                            }
                        ]
                    }
                }
                jsonl_lines.append(json.dumps(jsonl_record))
                tagging_manifest["records"][record_id] = frame

        # -----------------------------
        # 3. Save input + manifest
        # -----------------------------
        s3.put_object(
            Bucket=bucket,
            Key=tagging_input_key,
            Body="\n".join(jsonl_lines).encode("utf-8"),
            ContentType="application/jsonl"
        )

        s3.put_object(
            Bucket=bucket,
            Key=tagging_manifest_key,
            Body=json.dumps(tagging_manifest, indent=2).encode("utf-8"),
            ContentType="application/json"
        )

        # -----------------------------
        # 4. Start Bedrock batch job
        # -----------------------------
        job_name = f"vaidio-tag-{int(time.time() * 1000)}"

        input_data_config = {
            "s3InputDataConfig": {
                "s3Uri": tagging_input_s3_uri
            }
        }
        output_data_config = {
            "s3OutputDataConfig": {
                "s3Uri": bedrock_output_s3_uri
            }
        }

        if CLIENT_BUCKET_OWNER:
            input_data_config["s3InputDataConfig"]["s3BucketOwner"] = CLIENT_BUCKET_OWNER
            output_data_config["s3OutputDataConfig"]["s3BucketOwner"] = CLIENT_BUCKET_OWNER

        bedrock_response = bedrock.create_model_invocation_job(
            jobName=job_name,
            roleArn=bedrock_role_arn,
            modelId=model_id,
            inputDataConfig=input_data_config,
            outputDataConfig=output_data_config
        )

        # -----------------------------
        # 5. Update status
        # -----------------------------
        existing_status = read_existing_status(bucket, status_key)

        status = {
            **existing_status,
            "dataset_id": dataset_id,
            "current_stage": "bedrock_batch_running",
            "updated_at": now_iso()
        }

        s3.put_object(
            Bucket=bucket,
            Key=status_key,
            Body=json.dumps(status, indent=2).encode("utf-8"),
            ContentType="application/json"
        )

        return {
            "success": True,
            "jobArn": bedrock_response.get("jobArn"),
            "jobName": job_name
        }

    except Exception as error:
        print("StartBedrockTagging error:")
        print(str(error))
        raise
