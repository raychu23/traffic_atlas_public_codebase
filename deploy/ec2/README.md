# EC2 API deployment

The always-running `traffic_atlas` EC2 instance is the API/control plane. The stopped-by-default GPU
EC2 instance is only a processor. This separation lets the dashboard accept uploads, expose job
status, and serve completed artifacts while GPU compute is off.

## One-time host preparation

1. Increase or replace the API host's current 8 GiB root volume. A 10 GiB upload limit cannot be
   supported safely by an 8 GiB disk. Prefer a separate encrypted EBS data volume mounted at
   `/var/lib/traffic-atlas`.
2. Create the service account and directories:

   ```bash
   sudo useradd --system --home /var/lib/traffic-atlas --shell /usr/sbin/nologin traffic-atlas
   sudo install -d -o traffic-atlas -g traffic-atlas -m 0750 \
     /opt/traffic-atlas /var/lib/traffic-atlas/video /etc/traffic-atlas
   ```

3. Replace `<AWS_ACCOUNT_ID>` in `gpu-lifecycle-policy.json`, then attach an EC2 instance profile to
   the API host using that least-privilege policy. Do not copy a developer's long-lived AWS access
   keys onto the server.
4. Install the GPU worker SSH key as `/etc/traffic-atlas/gpu-worker.pem`, owned by
   `traffic-atlas:traffic-atlas` with mode `0400`.
5. Copy `api.env.example` to `/etc/traffic-atlas/api.env`, fill in the existing Cognito, S3, OpenAI,
   and CORS configuration, and keep the file mode `0640`.
6. Deploy the repository to a versioned directory under `/opt/traffic-atlas/releases/`, run
   `npm ci --omit=dev`, and atomically point `/opt/traffic-atlas/current` at that release.
7. Install and enable `traffic-atlas-api.service`, merge the nginx locations into the existing HTTPS
   server block, then validate and restart:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now traffic-atlas-api
   sudo nginx -t
   sudo systemctl reload nginx
   curl --fail http://127.0.0.1:5001/api/health
   ```

## Persistence behavior

`TRAFFIC_VIDEO_DATA_ROOT=/var/lib/traffic-atlas/video` keeps the following outside the Git checkout:

- `staging/`: incomplete uploads, cleared after an API restart;
- `sources/`: accepted source videos;
- `jobs/<video-id>/job.json`: durable job state;
- `jobs/<video-id>/`: previews, logs, trajectories, and zone GeoJSON;
- `jobs/<video-id>/output/`: tracks, annotated video, and count CSV files.

The API copies a source video to the GPU worker, retrieves outputs to this persistent API-host
volume, and then stops the GPU after the idle window.

## Deployment boundary

The repository's existing GitHub workflow performs verification only. A push does not update this
EC2 backend until either:

- a deploy workflow is given the `traffic-atlas` host's SSH deployment key and permission to restart
  this service; or
- an administrator performs the release/symlink/restart steps on the host.

Amplify can continue hosting the React frontend. Set its `REACT_APP_API_URL_TESTING` build variable to the
HTTPS API hostname.
