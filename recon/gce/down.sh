#!/bin/sh
# Deletes the VM, its disk and the firewall rule, along with any session on it.
# Usage: sh recon/gce/down.sh <gcp-project>
set -eu
PROJECT=${1:?Usage: sh recon/gce/down.sh <gcp-project>}
ZONE=europe-central2-a
NAME=zdrofi-recon

gcloud compute instances delete "$NAME" --project "$PROJECT" --zone "$ZONE" --quiet
gcloud compute firewall-rules delete "$NAME-iap-ssh" --project "$PROJECT" --quiet
