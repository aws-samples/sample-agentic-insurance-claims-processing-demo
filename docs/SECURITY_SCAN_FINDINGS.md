# AWS Security Agent Scan Findings — Claims Processing Demo

**Scan ID:** scan-086fb572  
**Status:** COMPLETED  
**Date:** July 6, 2026  
**Total Findings:** 18 (3 CRITICAL, 6 HIGH, 8 MEDIUM, 1 LOW)

---

## CRITICAL Findings (3)

### C1. Missing Server-Side Authorization — Any Authenticated User Can Approve/Deny/Wipe

**Risk:** PRIVILEGE_ESCALATION | Confidence: HIGH

All API endpoints validate Cognito token existence only — never check group membership. Any self-registered user can approve/deny claims, wipe all data via POST /reset, and read all claims.

**Locations:**
- `backend/lambda/claims/claims_handler.py:434-455` (approve_claim)
- `backend/lambda/claims/claims_handler.py:457-477` (deny_claim)
- `backend/lambda/claims/claims_handler.py:601-620` (reset_demo)
- `backend/lambda/claims/claims_handler.py:385-390` (list_claims)
- `backend/infrastructure/lib/api-stack.ts:44-46` (authorizer config)
- `backend/infrastructure/lib/infrastructure-stack.ts:159` (selfSignUpEnabled)

**Remediation:** Extract `cognito:groups` from `event.requestContext.authorizer.claims` and enforce role checks.

---

### C2. Mass Assignment in update_claim — Any User Can Overwrite Status, AI Decisions, Fraud Scores

**Risk:** BROKEN_OBJECT_PROPERTY_AUTHORIZATION | Confidence: HIGH

`update_claim` iterates over all JSON body keys (excluding only claimId/timestamp) and constructs dynamic DynamoDB UpdateExpression. Any field can be set: status, aiDecision, fraudScore, claimAmount, resubmissionCount.

**Locations:**
- `backend/lambda/claims/claims_handler.py:402-431`
- `backend/infrastructure/lib/api-stack.ts:258` (PUT route)

**Remediation:** Implement field allowlist. Only allow claimant-editable fields (notes, relationship, causeOfDeath).

---

### C3. Prompt Injection via Resubmit/Update/Documents Bypasses Input Filtering

**Risk:** CODE_INJECTION | Confidence: HIGH

`create_claim` has injection regex, but `resubmit_claim`, `update_claim`, and document uploads skip scanning. All converge into the LLM prompt via `.format()` interpolation.

**Locations:**
- `backend/lambda/claims/process_claim_handler.py:248-270` (prompt interpolation)
- `backend/lambda/claims/claims_handler.py:520-537` (resubmit no scanning)
- `backend/lambda/claims/claims_handler.py:402-431` (update no validation)
- `backend/lambda/claims/process_claim_handler.py:119-128` (document text unscanned)

**Remediation:** Apply same injection regex to resubmit fields and scan document text content before including in prompts.

---

## HIGH Findings (6)

### H1. Security-Critical Actions Lack User Identity Attribution in Audit Logs

**Risk:** SECURITY_MISCONFIGURATION | Confidence: HIGH

approve_claim, deny_claim, update_claim, reset_demo write to DynamoDB but never record who performed the action. No requestContext extraction.

**Locations:**
- `backend/lambda/claims/claims_handler.py:434-477`
- `backend/lambda/claims/claims_handler.py:402-431`

**Remediation:** Extract user identity from `event.requestContext.authorizer.claims` and store as `actionBy` field.

---

### H2. Claim State Machine Bypass — Terminal States Are Mutable

**Risk:** BUSINESS_LOGIC_VULNERABILITIES | Confidence: HIGH

approve_claim and deny_claim unconditionally set status without checking current state. Already-denied claims can be approved. update_claim can reset resubmissionCount.

**Locations:**
- `backend/lambda/claims/claims_handler.py:434-477`
- `backend/lambda/claims/claims_handler.py:416-420`

**Remediation:** Check current status before approve/deny. Only allow from escalated/resubmitted/submitted states.

---

### H3. Document Completeness Check Bypass via User-Controlled Document Type Names

**Risk:** AUTHENTICATION_BYPASS | Confidence: HIGH

User-supplied `documentType` field is used in S3 key path. Attacker can upload empty file with `documentType: "death_certificate"` to satisfy completeness check.

**Locations:**
- `backend/lambda/claims/process_claim_handler.py:337-356`
- `backend/lambda/documents/documents_handler.py:92-109`

**Remediation:** Validate documentType against allowlist of known types.

---

### H4. Bedrock Guardrail Defined But Never Applied to LLM Invocations

**Risk:** SECURITY_MISCONFIGURATION | Confidence: HIGH

Guardrail is defined in CDK with PROMPT_ATTACK, PII, topic controls but guardrailIdentifier is never passed to invoke_model calls in process_claim_handler or chat_handler.

**Locations:**
- `backend/lambda/claims/process_claim_handler.py:261-270`
- `backend/lambda/chat/chat_handler.py:86-96`
- `backend/infrastructure/lib/infrastructure-stack.ts:210-250`

**Remediation:** Pass GUARDRAIL_ID env var to Lambda handlers and include in invoke_model params.

---

### H5. Unsanitized User Input in S3 Key Construction — Path Traversal

**Risk:** PATH_TRAVERSAL | Confidence: HIGH

fileName and documentType are user-controlled with no path sanitization. Could inject `../` sequences.

**Locations:**
- `backend/lambda/documents/documents_handler.py:92-115`
- `backend/lambda/claims/process_claim_handler.py:100-134`

**Remediation:** Strip path separators, use os.path.basename, validate against allowlist.

---

### H6. AI Agent Tools Have Unrestricted Database Write Access Without Claim ID Validation

**Risk:** PRIVILEGE_ESCALATION | Confidence: MEDIUM

supervisor.py and adjudication.py tools accept claim_id parameter but never validate it matches the claim being processed. Prompt injection could write to other claims.

**Locations:**
- `backend/agents/supervisor/supervisor.py:329-360`
- `backend/agents/adjudication/adjudication.py:47-62`

**Remediation:** Pass expected claim_id as context and validate in tool before DynamoDB write.

---

## MEDIUM Findings (8)

| # | Finding | Risk Type |
|---|---------|-----------|
| M1 | Chat history role injection (forged assistant messages) | CODE_INJECTION |
| M2 | AI processing details/fraud scores exposed to claimants | INFORMATION_DISCLOSURE |
| M3 | CDK Nag suppressions with stale/inaccurate justifications | SECURITY_MISCONFIGURATION |
| M4 | Overly permissive IAM policies (wildcard resources) | SECURITY_MISCONFIGURATION |
| M5 | dataTraceEnabled logs full PII request bodies to CloudWatch | INFORMATION_DISCLOSURE |
| M6 | Legacy CloudFormation template with weaker security | SECURITY_MISCONFIGURATION |
| M7 | Metrics dashboard exposes PII to any authenticated user | INFORMATION_DISCLOSURE |
| M8 | Wildcard CORS headers in Lambda responses override API GW | SECURITY_MISCONFIGURATION |

---

## LOW Findings (1)

| # | Finding | Status |
|---|---------|--------|
| L1 | Hardcoded demo credentials (Test123!) bypass password policy | ALREADY FIXED — password updated to Test123!Pass (12 chars), MFA TOTP enforced |

---

## Notes

- M6 (Legacy CloudFormation template) — ALREADY FIXED: file was deleted in commit 5dcb90e
- L1 (Hardcoded credentials) — ALREADY FIXED: passwords updated, MFA enforced
- Scan was run against pre-remediation code; some findings may already be partially addressed
