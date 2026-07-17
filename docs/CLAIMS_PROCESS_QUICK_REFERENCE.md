# CCOE Insurance Industry LLC — Claims Process Quick Reference

## Processing Pipeline

```
Claim Submitted → Lambda creates DynamoDB record → Async self-invoke →
  5s wait → Fetch docs from S3 →
  PRIMARY: AgentCore Supervisor (6 ECR-based agents) →
  FALLBACK: Bedrock InvokeModel (Claude Sonnet 4) →
  AI returns JSON decision → DynamoDB updated
```

---

## AI Processing (Dual Path)

The Claims Lambda tries AgentCore Supervisor first. If AgentCore is unavailable (cold start timeout, etc.), it falls back to a single Claude Sonnet 4 InvokeModel call. Either path evaluates:

| Check | What It Does |
|-------|-------------|
| Authentication | Validates beneficiary matches policy designation |
| Document Verification | Reads uploaded documents, checks completeness and consistency |
| Policy Verification | Checks policy status, premiums, contestability, exclusions |
| Fraud Detection | Analyzes timing, beneficiary changes, amount patterns |
| Adjudication | Makes approve/deny/escalate decision based on all factors |

**Model**: `us.anthropic.claude-sonnet-4-20250514-v1:0`
**Lambda Timeout**: 15 minutes (900 seconds) | **Memory**: 256 MB | **Max Tokens**: 2048

---

## Decision Rules

### Auto-Approve (ALL required)
- Fraud score < 0.3
- Policy active with premiums current
- No exclusions apply
- All documents present and valid
- Claim amount < $100,000
- Not in contestability period (or no issues)

### Auto-Deny (ANY triggers)
- Policy lapsed (premiums unpaid)
- Excluded cause of death (e.g., suicide within contestability)
- Fraud score >= 0.7
- Material misrepresentation during contestability

### Escalate to Human (ANY triggers)
- Claim amount ≥ $100,000
- Fraud score 0.5–0.7 (moderate risk)
- Missing critical documents
- Beneficiary disputes or unclear designations
- Complex policy exclusion questions

---

## Claim Statuses

| Status | Meaning |
|--------|---------|
| `submitted` | Claim received, async processing starting |
| `processing` | AI analysis in progress |
| `approved` | Claim approved, payout authorized |
| `denied` | Claim denied with reasoning |
| `escalated` | Sent to human adjuster for review |

---

## 9 Demo Scenarios

| # | Scenario | Amount | Key Trigger | Outcome |
|---|----------|--------|-------------|---------|
| 1 | Clean claim (natural death) | $25,000 | All criteria met | ✅ Auto-Approved |
| 2 | Lapsed policy | $30,000 | Policy lapsed 6 months ago | ❌ Auto-Denied |
| 3 | Suspicious timing & fraud | $45,000 | Policy 83 days old, 10x increase | ❌ Auto-Denied (Fraud) |
| 4 | High-value clean claim | $150,000 | Amount ≥ $100K threshold | ⏸️ Escalated |
| 5 | Incomplete submission | $35,000 | Missing death cert & medical records | ⏸️ Escalated |
| 6 | Suicide within contestability | $40,000 | Excluded cause + misrepresentation | ❌ Auto-Denied |
| 7 | Undisclosed pre-existing | $28,000 | Fraud score 0.5–0.7 | ⏸️ Escalated |
| 8 | Grace period death | $45,000 | Death within 31-day grace period | ✅ Approved |
| 9 | War/terrorism exclusion | $50,000 | Military combat death, policy excludes | ❌ Auto-Denied |

Use the Demo Quick-Fill dropdown on the Submit Claim page to auto-fill any scenario.

---

## Required Documents

1. **Death Certificate** (required) — date of death, cause, certifying physician
2. **Policy Document** — policy number, status, coverage, beneficiary
3. **Beneficiary ID** — government-issued identification
4. **Medical Records** (if applicable) — diagnosis, treatment history

The AI reads uploaded document text and includes findings in its adjudication.

---

## Fraud Risk Indicators

### High Risk
- Policy purchased < 6 months before death
- Beneficiary changed recently before death
- Large coverage increase shortly before death
- Accidental death with no autopsy
- Conflicting information across documents

### Moderate Risk
- Incomplete documentation
- Delayed reporting (> 90 days)
- Undisclosed pre-existing conditions
- Non-family beneficiary

### Low Risk (reduces score)
- Natural causes with documented medical history
- Policy > 5 years old
- Complete documentation
- Timely reporting

---

## Architecture Note

6 specialist agents (Supervisor, Authenticator, Extractor, PolicyVerification, FraudDetection, Adjudication) are deployed on Bedrock AgentCore as ECR-based ARM64 containers built via CodeBuild. The Supervisor orchestrates specialists in a 4-phase parallel pipeline using `ThreadPoolExecutor` (Phase 1: Authenticate ∥ Extract, Phase 2: PolicyVerify ∥ FraudDetect, Phase 3: Adjudicate, Phase 4: Synthesize). The Claims Lambda tries AgentCore Supervisor first (`_invoke_agentcore_supervisor()`). If that fails, it falls back to direct Bedrock InvokeModel (`_process_claim_with_bedrock()`). The `processing_path` field in the result tracks which path was used (`agentcore` or `bedrock_direct`).

The system is deployed across 3 consolidated CDK stacks: `LifeInsuranceInfraStack`, `LifeInsuranceAgentStack`, `LifeInsuranceApiStack`.

---

## Key Technical Details

- DynamoDB composite key: `claimId` (partition) + `timestamp` (sort) — all operations must query first
- Lambda self-invokes with `InvocationType='Event'` for async processing (API Gateway has 29s hard limit)
- `POLICY_DATABASE` dict in `claims_handler.py` provides policy context for all 9 demo scenarios
- 5-second delay in async handler lets document uploads complete before AI processing
- AI prompt includes strict decision rules and document verification instructions
- Chatbot uses Claude Sonnet 4 with 512 max tokens, temperature 0.3, conversation history (last 6 messages)

---

**For detailed scenario walkthroughs**: [DEMO_TESTING_GUIDE.md](DEMO_TESTING_GUIDE.md)
**For deployment steps**: [DEPLOYMENT_GUIDE.md](../DEPLOYMENT_GUIDE.md)
