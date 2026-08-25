"""Hard billing cap for visualsprint-agent.

Triggered by Pub/Sub (topic: billing-budget-alert) on every budget threshold
notification GCP's Billing Budget service sends. Most notifications are
informational (cost still under budget) -- this function only acts once
cost_amount has actually crossed budget_amount, at which point it disables
billing on the project entirely. That kills every GCP resource in the
project (Cloud Run, GCS, Vertex AI/Gemini, Cloud SQL if any) until billing
is manually re-linked in the console -- this is a deliberate hard stop, not
a soft alert. See CLAUDE.md for why this exists and how to undo it.

Uses print(), not the logging module -- the Cloud Functions Python runtime
installs its own root logging handler before user code loads, so
logging.basicConfig() here is a silent no-op (verified: an INFO call never
reached Cloud Logging even with basicConfig set). print() always lands on
stdout, which Cloud Run captures as a log entry regardless of handler
config, so it's the reliable choice for a function this small.
"""

import base64
import json

from google.cloud import billing_v1

PROJECT_ID = "visualsprint-agent"
PROJECT_NAME = f"projects/{PROJECT_ID}"


def stop_billing(event: dict, context) -> None:
    pubsub_data = json.loads(base64.b64decode(event["data"]).decode("utf-8"))
    cost_amount = pubsub_data.get("costAmount", 0)
    budget_amount = pubsub_data.get("budgetAmount", 0)

    if cost_amount <= budget_amount:
        print(f"under budget: cost={cost_amount} budget={budget_amount} -- no action")
        return

    billing_client = billing_v1.CloudBillingClient()
    project_billing_info = billing_client.get_project_billing_info(name=PROJECT_NAME)

    if not project_billing_info.billing_enabled:
        print(f"billing already disabled on {PROJECT_NAME}")
        return

    print(f"cost {cost_amount} exceeded budget {budget_amount} -- disabling billing on {PROJECT_NAME}")
    billing_client.update_project_billing_info(
        name=PROJECT_NAME,
        project_billing_info=billing_v1.ProjectBillingInfo(billing_account_name=""),
    )
    print(f"billing disabled on {PROJECT_NAME}")
