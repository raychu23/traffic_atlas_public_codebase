import json
import boto3

REGION = "us-east-1"

bedrock = boto3.client("bedrock", region_name=REGION)


def s3_uri_to_bucket_and_prefix(s3_uri):
    # Example:
    # s3://bucket/path/to/output/
    if not s3_uri.startswith("s3://"):
        raise Exception(f"Invalid S3 URI: {s3_uri}")

    without_scheme = s3_uri.replace("s3://", "", 1)
    parts = without_scheme.split("/", 1)

    bucket = parts[0]
    prefix = parts[1] if len(parts) > 1 else ""

    if prefix and not prefix.endswith("/"):
        prefix += "/"

    return bucket, prefix


def lambda_handler(event, context):
    print("CheckBedrockBatchJob event:")
    print(json.dumps(event, indent=2))

    job_arn = event.get("jobArn")

    if not job_arn:
        raise Exception("Missing required input: jobArn")

    try:
        response = bedrock.get_model_invocation_job(
            jobIdentifier=job_arn
        )

        raw_status = response.get("status")
        print(f"Job status: {raw_status}")

        state = "IN_PROGRESS"

        if raw_status == "Completed":
            state = "SUCCEEDED"
        elif raw_status == "Failed":
            state = "FAILED"

        output_s3_uri = None
        output_bucket = None
        bedrock_output_prefix = None

        output_config = response.get("outputDataConfig", {})
        s3_output_config = output_config.get("s3OutputDataConfig", {})

        output_s3_uri = s3_output_config.get("s3Uri")
        output_bucket, bedrock_output_prefix = s3_uri_to_bucket_and_prefix(output_s3_uri)

        return {
                "success": True,
                "jobArn": job_arn,
                "rawStatus": raw_status,
                "state": state,
                "failureReason": response.get("failureReason"),
                "output_s3_uri": output_s3_uri,
                "output_bucket": output_bucket,
                "bedrock_output_prefix": bedrock_output_prefix
            }

    except Exception as error:
        print("CheckBedrockBatchJob error:")
        print(str(error))
        raise