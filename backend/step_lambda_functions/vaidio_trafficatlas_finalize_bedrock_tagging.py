import json
import re
import boto3
from datetime import datetime, timezone
from botocore.exceptions import ClientError

REGION = "us-east-1"
s3 = boto3.client("s3", region_name=REGION)

TAG_FIELDS = [
    "lighting",
    "weather",
    "road_type",
    "traffic_density",
    "vehicle_presence",
    "pedestrian_presence",
    "cyclist_presence",
    "truck_presence",
    "bus_presence",
    "motorcycle_presence",
    "emergency_vehicle_presence"
]


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def read_json_from_s3(bucket, key):
    obj = s3.get_object(Bucket=bucket, Key=key)
    body = obj["Body"].read().decode("utf-8")
    return json.loads(body)


def put_json_to_s3(bucket, key, data):
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(data, indent=2).encode("utf-8"),
        ContentType="application/json",
        ServerSideEncryption="AES256"
    )


def put_text_to_s3(bucket, key, text, content_type="text/plain"):
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=text.encode("utf-8"),
        ContentType=content_type,
        ServerSideEncryption="AES256"
    )


def read_existing_status(bucket, status_key):
    try:
        return read_json_from_s3(bucket, status_key)
    except ClientError as err:
        code = err.response.get("Error", {}).get("Code")
        status_code = err.response.get("ResponseMetadata", {}).get("HTTPStatusCode")

        if code in ["NoSuchKey", "404", "NotFound"] or status_code == 404:
            return {}

        raise


def safe_json_parse(text):
    if not text or not isinstance(text, str):
        return None

    try:
        return json.loads(text)
    except Exception:
        pass

    match = re.search(r"\{[\s\S]*\}", text)
    if not match:
        return None

    try:
        return json.loads(match.group(0))
    except Exception:
        return None


def extract_claude_text(record):
    output = (
        record.get("modelOutput")
        or record.get("output")
        or record.get("outputBody")
    )

    if not output:
        return ""

    body = output

    if isinstance(body, str):
        parsed = safe_json_parse(body)
        body = parsed if parsed is not None else body

    if isinstance(body, dict) and isinstance(body.get("body"), str):
        parsed = safe_json_parse(body["body"])
        body = parsed if parsed is not None else body["body"]

    if isinstance(body, dict) and isinstance(body.get("content"), list):
        return "\n".join(
            item.get("text", "")
            for item in body["content"]
            if item.get("text")
        )

    if (
        isinstance(body, dict)
        and isinstance(body.get("message"), dict)
        and isinstance(body["message"].get("content"), list)
    ):
        return "\n".join(
            item.get("text", "")
            for item in body["message"]["content"]
            if item.get("text")
        )

    if isinstance(body, str):
        return body

    return json.dumps(body)


def normalize_tags(parsed):
    tags = {}

    for field in TAG_FIELDS:
        value = parsed.get(field) if isinstance(parsed, dict) else None
        tags[field] = str(value).strip() if value else "unknown"

    short_description = ""
    if isinstance(parsed, dict) and parsed.get("short_description"):
        short_description = str(parsed["short_description"]).strip()

    return {
        "tags": tags,
        "short_description": short_description
    }


def increment(obj, key, amount=1):
    obj[key] = obj.get(key, 0) + amount


def list_bedrock_output_files(bucket, prefix):
    output_files = []
    continuation_token = None

    while True:
        params = {
            "Bucket": bucket,
            "Prefix": prefix,
            "MaxKeys": 1000
        }

        if continuation_token:
            params["ContinuationToken"] = continuation_token

        response = s3.list_objects_v2(**params)

        for file_obj in response.get("Contents", []):
            key = file_obj["Key"]

            if key.lower().endswith(".jsonl.out"):
                output_files.append(key)

        if response.get("IsTruncated"):
            continuation_token = response.get("NextContinuationToken")
        else:
            break

    return output_files


def lambda_handler(event, context):
    print("FinalizeBedrockTagging event:")
    print(json.dumps(event, indent=2))

    dataset_id = event.get("dataset_id")
    bucket = event.get("bucket")
    bedrock_output_prefix = event.get("bedrock_output_prefix")

    if not dataset_id or not bucket or not bedrock_output_prefix:
        raise Exception("Missing required input: dataset_id, bucket, or bedrock_output_prefix")

    dataset_root_prefix = event.get(
        "dataset_root_prefix",
        f"traffic-atlas/datasets/{dataset_id}/"
    )

    base_prefix = f"{dataset_root_prefix.rstrip('/')}/analysis"
    manifest_key = f"{base_prefix}/bedrock/manifest/tagging_manifest.json"
    status_key = f"{base_prefix}/status/processing_status.json"

    try:
        manifest = read_json_from_s3(bucket, manifest_key)
        manifest_records = manifest.get("records", {})

        output_files = list_bedrock_output_files(bucket, bedrock_output_prefix)

        if not output_files:
            raise Exception(f"No Bedrock output JSONL found under {bedrock_output_prefix}")

        video_summaries = {}
        dataset_distribution = {field: {} for field in TAG_FIELDS}
        all_frame_tags = []

        total_frames_tagged = 0
        parse_failures = 0
        missing_manifest_records = 0

        for output_file in output_files:
            obj = s3.get_object(Bucket=bucket, Key=output_file)
            file_str = obj["Body"].read().decode("utf-8")

            readable_output_key = f"{base_prefix}/bedrock/parsed/raw_readable/tagging_output_readable.jsonl"

            put_text_to_s3(
                bucket=bucket,
                key=readable_output_key,
                text=file_str,
                content_type="application/jsonl"
            )

            lines = [line for line in file_str.split("\n") if line.strip()]

            for line in lines:
                try:
                    record = json.loads(line)
                except Exception:
                    parse_failures += 1
                    continue

                record_id = (
                    record.get("recordId")
                    or record.get("record_id")
                    or record.get("id")
                )

                frame_info = manifest_records.get(record_id)

                if not record_id or not frame_info:
                    missing_manifest_records += 1
                    continue

                response_text = extract_claude_text(record)
                parsed = safe_json_parse(response_text)

                if not parsed:
                    parse_failures += 1

                normalized = normalize_tags(parsed)

                video_name = frame_info.get("video_name")
                frame_stem = frame_info.get("frame_stem")

                frame_tag_metadata = {
                    "dataset_id": dataset_id,
                    "recordId": record_id,
                    "video_name": video_name,
                    "frame_name": frame_info.get("frame_name"),
                    "frame_stem": frame_stem,
                    "frame_s3_key": frame_info.get("frame_key") or frame_info.get("frame_s3_key"),
                    "frame_s3_uri": frame_info.get("s3_uri") or frame_info.get("frame_s3_uri"),
                    "tags": normalized["tags"],
                    "short_description": normalized["short_description"],
                    "parsed_successfully": bool(parsed),
                    "raw_response_text": response_text,
                    "bedrock_output_file": output_file,
                    "processed_at": now_iso()
                }

                all_frame_tags.append(frame_tag_metadata)

                if video_name not in video_summaries:
                    video_summaries[video_name] = {
                        "dataset_id": dataset_id,
                        "video_name": video_name,
                        "frame_count": 0,
                        "source_frames_prefix": f"{base_prefix}/frames/{video_name}/",
                        "frame_record_ids": [],
                        "tag_counts": {},
                        "category_counts": {field: {} for field in TAG_FIELDS},
                        "sample_descriptions": []
                    }

                video_summary = video_summaries[video_name]

                video_summary["frame_count"] += 1
                video_summary["frame_record_ids"].append(record_id)

                if normalized["short_description"]:
                    video_summary["sample_descriptions"].append({
                        "recordId": record_id,
                        "frame_name": frame_info.get("frame_name"),
                        "description": normalized["short_description"]
                    })

                for field in TAG_FIELDS:
                    value = normalized["tags"].get(field, "unknown")
                    flat_tag = f"{field}.{value}"

                    increment(video_summary["tag_counts"], flat_tag)
                    increment(video_summary["category_counts"][field], value)
                    increment(dataset_distribution[field], value)

                total_frames_tagged += 1

        frame_level_prefix = f"{base_prefix}/tags/frame_level"

        frame_tags_json_key = f"{frame_level_prefix}/frame_tags.json"
        frame_tags_jsonl_key = f"{frame_level_prefix}/frame_tags.jsonl"

        put_json_to_s3(bucket, frame_tags_json_key, {
            "dataset_id": dataset_id,
            "generated_at": now_iso(),
            "total_frames": len(all_frame_tags),
            "records": all_frame_tags
        })

        put_text_to_s3(
            bucket=bucket,
            key=frame_tags_jsonl_key,
            text="\n".join(json.dumps(row) for row in all_frame_tags),
            content_type="application/jsonl"
        )

        video_summary_keys = []

        for video_name, summary in video_summaries.items():
            dominant_tags = {}

            for field in TAG_FIELDS:
                counts = summary["category_counts"].get(field, {})
                sorted_counts = sorted(
                    counts.items(),
                    key=lambda x: x[1],
                    reverse=True
                )

                dominant_tags[field] = sorted_counts[0][0] if sorted_counts else "unknown"

            final_video_summary = {
                **summary,
                "dominant_tags": dominant_tags,
                "sample_descriptions": summary["sample_descriptions"][:10],
                "frame_level_json": frame_tags_json_key,
                "frame_level_jsonl": frame_tags_jsonl_key,
                "processing_date": now_iso()
            }

            video_summary_key = f"{base_prefix}/tags/video_level/{video_name}.json"

            put_json_to_s3(bucket, video_summary_key, final_video_summary)
            video_summary_keys.append(video_summary_key)

        all_flat_tag_counts = {}

        for field, values in dataset_distribution.items():
            for value, count in values.items():
                all_flat_tag_counts[f"{field}.{value}"] = count

        top_tags = []

        for tag, count in sorted(
            all_flat_tag_counts.items(),
            key=lambda x: x[1],
            reverse=True
        )[:15]:
            percentage = round((count / total_frames_tagged) * 100, 2) if total_frames_tagged > 0 else 0
            top_tags.append({
                "tag": tag,
                "count": count,
                "percentage": percentage
            })

        dominant_tags = {}

        for field in TAG_FIELDS:
            sorted_counts = sorted(
                dataset_distribution.get(field, {}).items(),
                key=lambda x: x[1],
                reverse=True
            )

            dominant_tags[field] = sorted_counts[0][0] if sorted_counts else "unknown"

        filter_tags = [
            f"{field}.{value}"
            for field, value in dominant_tags.items()
            if value != "unknown"
        ]

        dataset_summary = {
            "dataset_id": dataset_id,
            "generated_at": now_iso(),
            "total_videos": len(video_summaries),
            "total_frames_tagged": total_frames_tagged,
            "source_references": {
                "tagging_manifest_key": manifest_key,
                "bedrock_output_prefix": bedrock_output_prefix,
                "frame_level_json": frame_tags_json_key,
                "frame_level_jsonl": frame_tags_jsonl_key,
                "video_summary_files": video_summary_keys
            },
            "dominant_tags": dominant_tags,
            "top_tags": top_tags,
            "filter_tags": filter_tags,
            "ready_for_web_display": True
        }

        dataset_level_prefix = f"{base_prefix}/tags/dataset_level"

        summary_key = f"{dataset_level_prefix}/dataset_summary.json"
        filter_tags_key = f"{dataset_level_prefix}/dataset_filter_tags.json"
        distribution_key = f"{dataset_level_prefix}/dataset_tag_distribution.json"

        put_json_to_s3(bucket, summary_key, dataset_summary)

        put_json_to_s3(bucket, filter_tags_key, {
            "dataset_id": dataset_id,
            "generated_at": now_iso(),
            "filter_tags": filter_tags,
            "dominant_tags": dominant_tags
        })

        put_json_to_s3(bucket, distribution_key, {
            "dataset_id": dataset_id,
            "generated_at": now_iso(),
            "total_frames_tagged": total_frames_tagged,
            "tag_distribution": dataset_distribution,
            "top_tags": top_tags
        })

        existing_status = read_existing_status(bucket, status_key)

        status = {
            **existing_status,
            "dataset_id": dataset_id,
            "current_stage": "tagging_completed",
            "overall_status": "completed",
            "updated_at": now_iso(),
            "steps": {
                **existing_status.get("steps", {}),
                "tag_parsing": {
                    "status": "completed",
                    "frames_tagged": total_frames_tagged,
                    "videos_processed": len(video_summaries),
                    "parse_failures": parse_failures,
                    "missing_manifest_records": missing_manifest_records,
                    "frame_level_json": frame_tags_json_key,
                    "frame_level_jsonl": frame_tags_jsonl_key,
                    "completed_at": now_iso()
                },
                "dataset_summary": {
                    "status": "completed",
                    "summary_key": summary_key,
                    "filter_tags_key": filter_tags_key,
                    "distribution_key": distribution_key,
                    "completed_at": now_iso()
                }
            }
        }

        put_json_to_s3(bucket, status_key, status)

        return {
            "success": True,
            "dataset_id": dataset_id,
            "total_frames_tagged": total_frames_tagged,
            "videos_processed": len(video_summaries),
            "parse_failures": parse_failures,
            "missing_manifest_records": missing_manifest_records,
            "frame_level_json": frame_tags_json_key,
            "frame_level_jsonl": frame_tags_jsonl_key,
            "summary_key": summary_key,
            "filter_tags_key": filter_tags_key,
            "distribution_key": distribution_key,
            "status_key": status_key
        }

    except Exception as error:
        print("FinalizeBedrockTagging error:")
        print(str(error))
        raise