#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -lt 4 ]]; then
  echo "Usage: install-worker.sh QUEUE_URL TABLE_NAME REGION IDLE_TIMEOUT_SECONDS" >&2
  exit 2
fi

QUEUE_URL="$1"
TABLE_NAME="$2"
REGION="$3"
IDLE_TIMEOUT_SECONDS="$4"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/opt/traffic-atlas-worker"

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs python3 python3-venv
install -d -m 0755 "$INSTALL_DIR" /etc/traffic-atlas
install -m 0755 "$SOURCE_DIR/traffic_video_worker.py" "$INSTALL_DIR/traffic_video_worker.py"
install -m 0755 "$SOURCE_DIR/finalize-video-job.js" "$INSTALL_DIR/finalize-video-job.js"
install -m 0644 "$SOURCE_DIR/videoJobs.js" "$INSTALL_DIR/videoJobs.js"
python3 -m venv "$INSTALL_DIR/venv"
"$INSTALL_DIR/venv/bin/pip" install --no-cache-dir -r "$SOURCE_DIR/requirements.txt"

cat > /etc/traffic-atlas/video-worker.env <<EOF
AWS_REGION=$REGION
TRAFFIC_VIDEO_QUEUE_URL=$QUEUE_URL
TRAFFIC_VIDEO_JOBS_TABLE=$TABLE_NAME
TRAFFIC_WORK_ROOT=/srv/traffic-video/queue-work
TRAFFIC_APP_ROOT=/srv/traffic-video/app
TRAFFIC_YOLO_IMAGE=traffic-yolo:cam5-reference
TRAFFIC_COUNT_IMAGE=traffic-video:ds8-atlas-20260722
TRAFFIC_IDLE_TIMEOUT_SECONDS=$IDLE_TIMEOUT_SECONDS
TRAFFIC_FINALIZER=$INSTALL_DIR/finalize-video-job.js
TRAFFIC_VIDEO_JOBS_MODULE=$INSTALL_DIR/videoJobs.js
EOF
chmod 0600 /etc/traffic-atlas/video-worker.env

install -m 0644 "$SOURCE_DIR/traffic-video-worker.service" \
  /etc/systemd/system/traffic-video-worker.service
systemctl daemon-reload
systemctl enable traffic-video-worker.service
systemctl restart traffic-video-worker.service
