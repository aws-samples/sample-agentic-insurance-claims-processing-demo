# Amazon QuickSight Integration — Effort Analysis

Detailed effort estimate for integrating Amazon QuickSight into the CCOE Insurance claims processing system, replacing the custom Business Dashboard with enterprise-grade BI.

---

## Current State Assessment

### What Exists Today

The Business Dashboard (`business1` role) is a custom React component (`BusinessDashboard.tsx`) that:

1. Calls `GET /metrics/dashboard` on every page load
2. The Metrics Lambda (`metrics_handler.py`) does a full DynamoDB table scan of `LifeInsuranceClaims`
3. Computes ~30 metrics in-memory (status counts, STP rate, fraud detections, cost breakdowns, token usage)
4. Returns a single JSON payload rendered by the React component into metric tiles, tables, and bars

### What Works Well
- Real-time data (reads directly from DynamoDB)
- Zero additional infrastructure (just a Lambda + React component)
- Cost analytics with per-complexity breakdowns

### What Doesn't Scale
- Full table scan on every dashboard load — O(n) cost and latency as claims grow
- No historical trending (only current snapshot)
- No ad-hoc queries (fixed set of metrics)
- No drill-down, filtering, or export capabilities
- No anomaly detection or forecasting
- Single-user view (no per-adjuster or per-region breakdowns)
- No scheduled reports or email digests

---

## Integration Architecture

Two viable approaches, with different trade-offs:

### Option A: Near-Real-Time Pipeline (Recommended)

```
DynamoDB Streams (already enabled)
    → Kinesis Data Firehose (buffered delivery)
        → S3 (Parquet format, partitioned by date)
            → AWS Glue Crawler (schema discovery)
                → Athena (SQL queries)
                    → QuickSight (dashboards + embedded)
```

Why this option: DynamoDB Streams are already enabled on the Claims table (`stream: StreamViewType.NEW_AND_OLD_IMAGES`). This is the hardest piece to retrofit, and it's already done.

Latency: 1–5 minutes from claim update to dashboard refresh.

### Option B: Batch Export Pipeline

```
EventBridge Scheduler (hourly/daily)
    → Lambda (DynamoDB export to S3)
        → S3 (Parquet)
            → Glue Crawler
                → Athena
                    → QuickSight
```

Simpler but only refreshes on schedule. Good enough if near-real-time isn't required.

---

## Work Breakdown

### Stream 1: Data Pipeline (CDK Infrastructure)

| Task | Description | Effort | Complexity |
|------|-------------|--------|------------|
| 1.1 | Kinesis Data Firehose delivery stream (DynamoDB Streams → S3) | 3 days | Medium |
| 1.2 | Lambda transformer for Firehose (flatten DynamoDB JSON → flat Parquet-friendly records) | 2 days | Medium |
| 1.3 | S3 data lake bucket with date-partitioned prefix structure (`claims/year=YYYY/month=MM/day=DD/`) | 0.5 days | Low |
| 1.4 | Glue Database + Crawler for schema discovery on the S3 data | 1 day | Low |
| 1.5 | Athena workgroup + named queries for common analytics | 1 day | Low |
| 1.6 | IAM roles and policies for the full pipeline | 1 day | Medium |
| **Subtotal** | | **8.5 days** | |

Key detail on 1.2: The DynamoDB Stream record format is nested (`{"S": "value"}` typed attributes). The Firehose transformer Lambda needs to flatten this into plain columns:

```python
# Input (DynamoDB Stream record):
{"claimId": {"S": "CLM-20260306-abc"}, "claimAmount": {"N": "25000"}, ...}

# Output (flat record for Parquet):
{"claimId": "CLM-20260306-abc", "claimAmount": 25000, "status": "approved",
 "fraudScore": 0.15, "confidenceScore": 0.95, "processingPath": "bedrock_direct",
 "complexity": "simple", "submittedAt": "2026-03-06T10:30:00Z", ...}
```

The `processingDetails` JSON string needs to be parsed and key fields extracted into top-level columns (fraud_score, confidence, processing_path, input_tokens, output_tokens, document_findings).

### Stream 2: QuickSight Setup

| Task | Description | Effort | Complexity |
|------|-------------|--------|------------|
| 2.1 | QuickSight Enterprise account setup + SPICE dataset from Athena | 1 day | Low |
| 2.2 | Claims Overview dashboard (status breakdown, volume trends, processing times) | 2 days | Medium |
| 2.3 | Fraud Analytics dashboard (score distributions, flagged claims, detection rates) | 2 days | Medium |
| 2.4 | AI Performance dashboard (token usage, cost trends, model confidence, STP rate over time) | 2 days | Medium |
| 2.5 | Operational dashboard (adjuster workload, SLA tracking, cycle times) | 1.5 days | Medium |
| 2.6 | Cost Analytics dashboard (per-complexity costs, Bedrock vs AgentCore vs Lambda breakdown) | 1.5 days | Medium |
| 2.7 | QuickSight ML anomaly detection on claims volume and fraud rates | 1 day | Low |
| 2.8 | Scheduled email reports (daily summary, weekly executive digest) | 0.5 days | Low |
| **Subtotal** | | **11.5 days** | |

### Stream 3: Frontend Embedding

| Task | Description | Effort | Complexity |
|------|-------------|--------|------------|
| 3.1 | QuickSight Embedding SDK integration in React app | 2 days | Medium |
| 3.2 | Backend Lambda for generating QuickSight embedding URLs (session-based, Cognito-linked) | 1.5 days | Medium |
| 3.3 | Replace BusinessDashboard.tsx with embedded QuickSight container | 1 day | Low |
| 3.4 | Row-level security (RLS) dataset rules so adjusters see only their assigned claims | 1 day | Medium |
| 3.5 | Cognito → QuickSight user/group mapping for role-based dashboard access | 1 day | Medium |
| **Subtotal** | | **6.5 days** | |

### Stream 4: CDK Stack Changes

| Task | Description | Effort | Complexity |
|------|-------------|--------|------------|
| 4.1 | New CDK stack: `LifeInsuranceAnalyticsStack` (Firehose, Glue, Athena, S3 data lake) | 2 days | Medium |
| 4.2 | QuickSight resources via CDK (dataset, analysis, dashboard — limited CDK support, may need custom resources) | 2 days | High |
| 4.3 | API Gateway endpoint for QuickSight embedding URL generation | 0.5 days | Low |
| 4.4 | Update deploy.sh with analytics stack deployment phase | 0.5 days | Low |
| **Subtotal** | | **5 days** | |

### Stream 5: Testing & Migration

| Task | Description | Effort | Complexity |
|------|-------------|--------|------------|
| 5.1 | End-to-end pipeline testing (submit claim → DynamoDB → Stream → Firehose → S3 → Athena → QuickSight) | 2 days | Medium |
| 5.2 | Dashboard validation against current Metrics Lambda output (ensure parity) | 1 day | Low |
| 5.3 | Load testing with 1,000+ claims to verify SPICE refresh and query performance | 1 day | Medium |
| 5.4 | Documentation updates (ARCHITECTURE_DEEP_DIVE, DEPLOYMENT_GUIDE, ROADMAP) | 0.5 days | Low |
| **Subtotal** | | **4.5 days** | |

---

## Total Effort Summary

| Stream | Days | Can Parallelize? |
|--------|------|-----------------|
| 1. Data Pipeline | 8.5 | Start first |
| 2. QuickSight Dashboards | 11.5 | After Stream 1 |
| 3. Frontend Embedding | 6.5 | After Stream 2 |
| 4. CDK Stack Changes | 5.0 | Parallel with Stream 1 |
| 5. Testing & Migration | 4.5 | After Streams 1–3 |
| **Total (sequential)** | **36 days** | |
| **Total (with parallelism)** | **~22–25 days** | Streams 1+4 parallel, then 2+3 overlap |

### Team Size Recommendation
- 1 backend/infra engineer (Streams 1, 4): ~2 weeks
- 1 BI/analytics engineer (Stream 2): ~2.5 weeks
- 1 frontend engineer (Stream 3): ~1.5 weeks
- Overlap testing (Stream 5): ~1 week

With a 2-person team: ~4–5 weeks.  
With a 3-person team: ~3–4 weeks.  
Solo developer: ~7–8 weeks.

---

## AWS Cost Impact

### New Monthly Costs

| Service | Estimated Cost | Notes |
|---------|---------------|-------|
| QuickSight Enterprise | $18–24/month | $18/author + $0.30/session for readers (first author included in trial) |
| Kinesis Data Firehose | $5–10/month | $0.029/GB ingested; claims data is small (~1KB/record) |
| S3 Data Lake | $1–2/month | Parquet storage, minimal at demo scale |
| Glue Crawler | $1–5/month | $0.44/DPU-hour; runs daily, ~1 minute per run |
| Athena Queries | $2–5/month | $5/TB scanned; Parquet + partitioning keeps this low |
| SPICE Capacity | $0 (included) | 10GB included with Enterprise; claims data well under this |
| **Total Additional** | **$27–46/month** | |

### Cost at Scale (1,000 claims/month)
- Firehose: ~$0.03/month (1,000 records × ~1KB = ~1MB)
- Athena: ~$0.05/month (Parquet is highly compressed)
- QuickSight: $18 + reader sessions (pay-per-session at $0.30, capped at $5/reader/month)
- Total: still under $50/month additional

---

## What You Keep vs What You Replace

| Current Component | After Integration | Notes |
|-------------------|-------------------|-------|
| `BusinessDashboard.tsx` (React) | Embedded QuickSight iframe | Simpler frontend code |
| `metrics_handler.py` (Lambda) | Kept for API consumers | Still useful for programmatic access |
| `/metrics/dashboard` API | Kept | Non-dashboard consumers (mobile app, integrations) still use it |
| DynamoDB full table scan | Eliminated for dashboards | QuickSight reads from S3/Athena, not DynamoDB |
| Custom metric tiles | QuickSight visuals | Drag-and-drop, filterable, exportable |
| No historical data | Full history in S3 | Every claim state change preserved in the data lake |

The Metrics Lambda and API endpoint stay — they serve the existing API contract. QuickSight becomes the primary dashboard experience for the `business1` role, with the option to give adjusters and executives their own filtered views.

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| QuickSight CDK support is limited | Dashboard-as-code is harder | Use QuickSight console for dashboard design, CDK for infrastructure only |
| DynamoDB Stream → Firehose ordering | Duplicate or out-of-order records | Firehose deduplication + Athena queries use `MAX(timestamp)` per claimId |
| SPICE refresh latency | Dashboard shows stale data | Configure SPICE refresh schedule (hourly) or use direct query mode for real-time |
| QuickSight embedding auth complexity | Cognito → QuickSight identity mapping | Use `GenerateEmbedUrlForRegisteredUser` with QuickSight user provisioning via Cognito trigger |
| Parquet schema evolution | New DynamoDB fields break Glue schema | Use Glue Schema Registry or `TBLPROPERTIES ('skip.header.line.count'='1')` with flexible schema |

---

## Prerequisites Before Starting

- [ ] QuickSight Enterprise subscription activated in the AWS account
- [ ] At least one QuickSight author user created
- [ ] Verify DynamoDB Streams are enabled (already done — `NEW_AND_OLD_IMAGES`)
- [ ] Decide: near-real-time (Option A) or batch (Option B)
- [ ] Decide: embedded dashboards in React app or standalone QuickSight URL for business users

---

## Suggested Implementation Order

1. Stand up the data pipeline first (Stream 1 + 4) — this is the foundation
2. Build dashboards in the QuickSight console (Stream 2) — iterate visually
3. Embed into the React app (Stream 3) — once dashboards are stable
4. Test end-to-end and validate parity with current dashboard (Stream 5)
5. Deprecate the custom `BusinessDashboard.tsx` component (keep Metrics Lambda API)

---

**This analysis assumes a single-region deployment in us-east-1 with the current DynamoDB schema. Multi-region or multi-tenant deployments would add complexity to the data pipeline.**
