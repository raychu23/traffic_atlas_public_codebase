"""S3 notification handler: starts the one TrafficAtlas GPU when a job manifest arrives."""
import os
import urllib.parse
import boto3

ec2 = boto3.client("ec2")
INSTANCE_ID = os.environ["GPU_INSTANCE_ID"]


def handler(event, _context):
    keys = [
        urllib.parse.unquote_plus(record["s3"]["object"]["key"])
        for record in event.get("Records", [])
    ]
    manifests = [key for key in keys if "/control/" in key and key.endswith(".json")]
    if not manifests:
        return {"started": False, "reason": "no-control-manifest"}
    instance = ec2.describe_instances(InstanceIds=[INSTANCE_ID])["Reservations"][0]["Instances"][0]
    state = instance["State"]["Name"]
    if state == "stopping":
        # Let Lambda's asynchronous retry deliver the wake-up after shutdown.
        raise RuntimeError("GPU is stopping; retry the wake-up after it stops")
    if state == "stopped":
        ec2.start_instances(InstanceIds=[INSTANCE_ID])
        return {"started": True, "state": state, "manifests": manifests}
    return {"started": False, "state": state, "manifests": manifests}
