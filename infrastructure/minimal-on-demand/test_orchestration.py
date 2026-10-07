"""Offline lifecycle checks; AWS clients are replaced before loading workers."""
import io
import os
from pathlib import Path
import types
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).parent


def load(relative, clients):
    module = types.ModuleType(relative)
    fake_boto3 = types.SimpleNamespace(client=lambda name, **kwargs: clients[name])
    with patch.dict("sys.modules", {"boto3": fake_boto3}), patch.dict(os.environ, {
        "GPU_INSTANCE_ID": "i-test", "TRAFFIC_VIDEO_BUCKET": "test-bucket",
    }):
        exec(compile((ROOT / relative).read_text(), relative, "exec"), module.__dict__)
    return module


class WakeTests(unittest.TestCase):
    def test_stopping_instance_requests_retry_then_starts_when_stopped(self):
        ec2 = MagicMock()
        ec2.describe_instances.side_effect = [
            {"Reservations": [{"Instances": [{"State": {"Name": state}}]}]}
            for state in ["stopping", "stopped"]
        ]
        handler = load("lambda/wake_gpu.py", {"ec2": ec2}).handler
        event = {"Records": [{"s3": {"object": {"key": "jobs/id/control/track.json"}}}]}
        with self.assertRaisesRegex(RuntimeError, "stopping"):
            handler(event, None)
        ec2.start_instances.assert_not_called()
        self.assertTrue(handler(event, None)["started"])
        ec2.start_instances.assert_called_once_with(InstanceIds=["i-test"])

    def test_running_instance_does_not_restart(self):
        ec2 = MagicMock()
        ec2.describe_instances.return_value = {"Reservations": [{"Instances": [{"State": {"Name": "running"}}]}]}
        handler = load("lambda/wake_gpu.py", {"ec2": ec2}).handler
        result = handler({"Records": [{"s3": {"object": {"key": "jobs/id/control/track.json"}}}]}, None)
        self.assertFalse(result["started"])
        ec2.start_instances.assert_not_called()


class ManifestTests(unittest.TestCase):
    def test_finds_manifest_after_first_thousand_objects(self):
        s3 = MagicMock()
        first_page = {"Contents": [{"Key": f"jobs/old/output/{index}.csv"} for index in range(1000)], "IsTruncated": True}
        second_page = {"Contents": [{"Key": "jobs/new/control/track.json"}]}
        s3.list_objects_v2.return_value = first_page
        s3.get_paginator.return_value.paginate.return_value = [first_page, second_page]
        s3.get_object.return_value = {"Body": io.BytesIO(b'{"action":"track"}')}
        worker = load("worker/traffic_s3_worker.py", {"s3": s3, "ec2": MagicMock()})
        self.assertEqual(worker.next_manifest(), ("jobs/new/control/track.json", {"action": "track"}))


if __name__ == "__main__":
    unittest.main()
