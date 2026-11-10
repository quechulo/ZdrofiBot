#!/bin/sh
# R8: creates a small temporary VM in Warsaw. Billed until down.sh runs.
# Usage: sh recon/gce/up.sh <gcp-project>   (run from the repo root)
set -eu
PROJECT=${1:?Usage: sh recon/gce/up.sh <gcp-project>}
ZONE=europe-central2-a
NAME=zdrofi-recon

gcloud services enable compute.googleapis.com iap.googleapis.com --project "$PROJECT"

gcloud compute firewall-rules create "$NAME-iap-ssh" \
  --project "$PROJECT" --direction INGRESS --allow tcp:22 \
  --source-ranges 35.235.240.0/20 --target-tags "$NAME"

gcloud compute instances create "$NAME" \
  --project "$PROJECT" --zone "$ZONE" --machine-type e2-medium \
  --image-family debian-12 --image-project debian-cloud --boot-disk-size 20GB \
  --tags "$NAME" --no-service-account --no-scopes --shielded-secure-boot

echo "Waiting for SSH..."
until gcloud compute ssh "$NAME" --project "$PROJECT" --zone "$ZONE" --tunnel-through-iap \
  --command true --quiet 2>/dev/null; do sleep 5; done

# Named files only. recon/.out holds live sessions and must never leave this Mac.
tar -czf - recon/lib.mjs recon/login.mjs recon/session-watch.mjs recon/schedule-probe.mjs \
  recon/token-probe.mjs recon/timing-probe.sh recon/gce/vm-setup.sh recon/gce/vm-login.sh |
  gcloud compute ssh "$NAME" --project "$PROJECT" --zone "$ZONE" --tunnel-through-iap \
    --command 'tar -xzf - && sh recon/gce/vm-setup.sh'

echo
echo "Ready. Next:"
echo "  gcloud compute ssh $NAME --project $PROJECT --zone $ZONE --tunnel-through-iap -- -L 6080:localhost:6080"
