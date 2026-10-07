"""Offline lifecycle checks; AWS clients are replaced before loading workers."""
import io
import json
import os
from pathlib import Path
import types
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).parent


def load(relative, clients, environment=None):
    module = types.ModuleType(relative)
    fake_boto3 = types.SimpleNamespace(client=lambda name, **kwargs: clients[name])
    with patch.dict("sys.modules", {"boto3": fake_boto3}), patch.dict(os.environ, {
        "GPU_INSTANCE_ID": "i-test", "TRAFFIC_VIDEO_BUCKET": "test-bucket",
        "TRAFFIC_VIDEO_S3_PREFIX": "jobs", **(environment or {}),
    }):
        exec(compile((ROOT / relative).read_text(), relative, "exec"), module.__dict__)
    return module


def event(key="jobs/id/control/track.json"):
    return {"Records": [{"s3": {"bucket": {"name": "test-bucket"}, "object": {"key": key}}}]}


def active_s3():
    client = MagicMock()
    client.get_object.side_effect = lambda **kwargs: {"Body": io.BytesIO(b'{"state":"active"}')}
    return client


class WakeTests(unittest.TestCase):
    def test_stopping_instance_requests_retry_then_starts_when_stopped(self):
        ec2 = MagicMock()
        ec2.describe_instances.side_effect = [
            {"Reservations": [{"Instances": [{"State": {"Name": state}}]}]}
            for state in ["stopping", "stopped"]
        ]
        handler = load("lambda/wake_gpu.py", {"ec2": ec2, "s3": active_s3()}).handler
        with self.assertRaisesRegex(RuntimeError, "stopping"):
            handler(event(), None)
        ec2.start_instances.assert_not_called()
        self.assertTrue(handler(event(), None)["started"])
        ec2.start_instances.assert_called_once_with(InstanceIds=["i-test"])

    def test_running_instance_does_not_restart(self):
        ec2 = MagicMock()
        ec2.describe_instances.return_value = {"Reservations": [{"Instances": [{"State": {"Name": "running"}}]}]}
        handler = load("lambda/wake_gpu.py", {"ec2": ec2, "s3": active_s3()}).handler
        result = handler(event(), None)
        self.assertFalse(result["started"])
        ec2.start_instances.assert_not_called()

    def test_running_with_missing_or_unreadable_marker_requests_retry(self):
        ec2 = MagicMock()
        ec2.describe_instances.return_value = {"Reservations": [{"Instances": [{"State": {"Name": "running"}}]}]}
        s3 = active_s3()
        s3.get_object.side_effect = RuntimeError("marker unavailable")
        handler = load("lambda/wake_gpu.py", {"ec2": ec2, "s3": s3}).handler
        with self.assertRaisesRegex(RuntimeError, "marker unavailable"):
            handler(event(), None)
        ec2.start_instances.assert_not_called()

    def test_ignores_other_bucket_prefix_and_lifecycle_events(self):
        ec2 = MagicMock()
        handler = load("lambda/wake_gpu.py", {"ec2": ec2, "s3": active_s3()}).handler
        wrong_bucket = event()
        wrong_bucket["Records"][0]["s3"]["bucket"]["name"] = "other-bucket"
        for payload in [wrong_bucket, event("other/id/control/track.json"), event("jobs/_workers/i-test/lifecycle.json")]:
            self.assertFalse(handler(payload, None)["started"])
        ec2.describe_instances.assert_not_called()


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


class ShutdownHandshakeTests(unittest.TestCase):
    def setUp(self):
        self.objects = {"jobs/_workers/i-test/lifecycle.json": b'{"state":"active"}'}
        self.state = "running"
        self.s3 = MagicMock()
        self.ec2 = MagicMock()
        self.s3.put_object.side_effect = lambda **args: self.objects.__setitem__(args["Key"], args["Body"])
        self.s3.get_object.side_effect = lambda **args: {"Body": io.BytesIO(self.objects[args["Key"]])}
        self.s3.get_paginator.return_value.paginate.side_effect = lambda **args: [{
            "Contents": [{"Key": key} for key in sorted(self.objects) if key.startswith(args["Prefix"])],
        }]
        self.ec2.describe_instances.side_effect = lambda **args: {"Reservations": [{
            "Instances": [{"State": {"Name": self.state}}],
        }]}
        clients = {"s3": self.s3, "ec2": self.ec2}
        self.worker = load("worker/traffic_s3_worker.py", clients)
        self.wake = load("lambda/wake_gpu.py", clients)

    def test_upload_before_intent_is_caught_by_final_scan_and_cancels_stop(self):
        self.objects["jobs/id/control/track.json"] = b'{"action":"track"}'
        self.assertFalse(self.wake.handler(event(), None)["started"])
        self.assertFalse(self.worker.stop_if_idle("i-test"))
        self.ec2.stop_instances.assert_not_called()
        self.assertEqual(json.loads(self.objects[self.wake.LIFECYCLE_KEY])["state"], "active")

    def test_upload_after_final_scan_retries_wake_until_stopped(self):
        def during_stop(**args):
            # The final scan returned empty; EC2 can still report running here.
            self.objects["jobs/id/control/track.json"] = b'{"action":"track"}'
            with self.assertRaisesRegex(RuntimeError, "shutdown intent"):
                self.wake.handler(event(), None)
            self.state = "stopped"
        self.ec2.stop_instances.side_effect = during_stop
        self.assertTrue(self.worker.stop_if_idle("i-test"))
        self.assertTrue(self.wake.handler(event(), None)["started"])
        self.ec2.start_instances.assert_called_once_with(InstanceIds=["i-test"])

    def test_boot_clears_stale_intent_before_reading_jobs(self):
        self.objects[self.wake.LIFECYCLE_KEY] = b'{"state":"stopping"}'
        self.worker.instance_id = lambda: "i-test"
        self.worker.WORK_ROOT = MagicMock()
        def first_scan():
            self.assertEqual(json.loads(self.objects[self.wake.LIFECYCLE_KEY])["state"], "active")
            raise RuntimeError("end of startup test")
        self.worker.next_manifest = first_scan
        with self.assertRaisesRegex(RuntimeError, "end of startup test"):
            self.worker.main()

    def test_intent_write_failure_does_not_stop(self):
        self.s3.put_object.side_effect = RuntimeError("write denied")
        with self.assertRaisesRegex(RuntimeError, "write denied"):
            self.worker.stop_if_idle("i-test")
        self.ec2.stop_instances.assert_not_called()

    def test_boot_marker_failure_prevents_queue_work(self):
        self.worker.instance_id = lambda: "i-test"
        self.worker.WORK_ROOT = MagicMock()
        self.worker.next_manifest = MagicMock()
        self.s3.put_object.side_effect = RuntimeError("boot marker denied")
        with self.assertRaisesRegex(RuntimeError, "boot marker denied"):
            self.worker.main()
        self.worker.next_manifest.assert_not_called()
        self.ec2.stop_instances.assert_not_called()

    def test_final_scan_failure_does_not_stop(self):
        self.s3.get_paginator.side_effect = RuntimeError("scan unavailable")
        with self.assertRaisesRegex(RuntimeError, "scan unavailable"):
            self.worker.stop_if_idle("i-test")
        self.ec2.stop_instances.assert_not_called()

    def test_cancel_intent_failure_does_not_stop(self):
        self.objects["jobs/id/control/track.json"] = b'{"action":"track"}'
        def put(**args):
            if json.loads(args["Body"])["state"] == "active":
                raise RuntimeError("cancel denied")
            self.objects[args["Key"]] = args["Body"]
        self.s3.put_object.side_effect = put
        with self.assertRaisesRegex(RuntimeError, "cancel denied"):
            self.worker.stop_if_idle("i-test")
        self.ec2.stop_instances.assert_not_called()

    def test_worker_and_lambda_share_custom_prefix_marker_key(self):
        clients = {"s3": self.s3, "ec2": self.ec2}
        env = {"TRAFFIC_VIDEO_S3_PREFIX": "/custom/nested/"}
        worker = load("worker/traffic_s3_worker.py", clients, env)
        wake = load("lambda/wake_gpu.py", clients, env)
        worker.set_lifecycle("i-test", "active")
        self.assertEqual(wake.LIFECYCLE_KEY, "custom/nested/_workers/i-test/lifecycle.json")
        self.assertEqual(json.loads(self.objects[wake.LIFECYCLE_KEY])["state"], "active")


if __name__ == "__main__":
    unittest.main()
