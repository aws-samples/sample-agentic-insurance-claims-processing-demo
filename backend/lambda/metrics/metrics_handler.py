"""
Metrics Handler Lambda
Provides dashboard metrics and analytics
"""
import json
import os
import logging
import boto3
from decimal import Decimal
from collections import defaultdict
from datetime import datetime

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

dynamodb = boto3.resource('dynamodb')

CLAIMS_TABLE = os.environ['CLAIMS_TABLE']
METRICS_TABLE = os.environ['METRICS_TABLE']
ALLOWED_ORIGIN = os.environ.get('ALLOWED_ORIGIN', '*')

claims_table = dynamodb.Table(CLAIMS_TABLE)

CORS_HEADERS = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
}

# ── Cost model ──
# Bedrock InvokeModel (Claude Sonnet 4)
BEDROCK_COST_PER_1K_INPUT_TOKENS = 0.003
BEDROCK_COST_PER_1K_OUTPUT_TOKENS = 0.015

# Lambda
LAMBDA_COST_PER_INVOCATION = 0.0000002
LAMBDA_COST_PER_GB_SECOND = 0.0000166667
LAMBDA_MEMORY_GB = 0.25

# AgentCore Runtime (consumption-based pricing)
# CPU: $0.0895/vCPU-hour (charged only during active processing, I/O wait is free)
# Memory: $0.00945/GB-hour (charged for actual usage as it scales)
# Per-session cost for a typical 60s agent session with 30% active CPU:
#   CPU: 18s active × 1vCPU × ($0.0895/3600) = $0.000448
#   Memory: 60s × 2GB avg × ($0.00945/3600) = $0.000315
#   Total per session: ~$0.000763
# 6 agents invoked per claim in target architecture
AGENTCORE_RUNTIMES = 6
AGENTCORE_COST_PER_SESSION = 0.000763  # per agent session (from AWS pricing example)

# Production-scale assumption for cost modeling
PRODUCTION_MONTHLY_VOLUME = 1000

# Per-complexity cost profiles
# Simple: auto-approve/deny, single AI pass, ~1500 input + 400 output tokens, ~8s Lambda
#   AgentCore: 2 agent sessions (auth + adjudication) in target arch
# Standard: moderate analysis, ~2000 input + 600 output tokens, ~12s Lambda
#   AgentCore: 4 agent sessions (auth + policy + fraud + adjudication)
# Complex: escalated, multi-factor, ~3000 input + 800 output tokens, ~18s Lambda + adjuster
#   AgentCore: 6 agent sessions (all agents) + adjuster time
COMPLEXITY_PROFILES = {
    'simple': {
        'input_tokens': 1500,
        'output_tokens': 400,
        'lambda_duration_sec': 8,
        'agentcore_sessions': 2,
        'adjuster_cost': 0,
    },
    'standard': {
        'input_tokens': 2000,
        'output_tokens': 600,
        'lambda_duration_sec': 12,
        'agentcore_sessions': 4,
        'adjuster_cost': 0,
    },
    'complex': {
        'input_tokens': 3000,
        'output_tokens': 800,
        'lambda_duration_sec': 18,
        'agentcore_sessions': 6,
        'adjuster_cost': 5.00,
    },
}


def _classify_claim_complexity(claim):
    """Classify a claim as simple, standard, or complex based on its outcome."""
    status = str(claim.get('status', '')).lower()
    claim_amount = float(claim.get('claimAmount', 0))
    fraud_score = 0

    if claim.get('processingDetails'):
        try:
            details = json.loads(claim['processingDetails']) if isinstance(claim['processingDetails'], str) else claim['processingDetails']
            fraud_score = float(details.get('fraud_score', 0))
        except (json.JSONDecodeError, ValueError, TypeError):
            pass

    # Complex: escalated, high-value, or high fraud score
    if status == 'escalated' or claim_amount >= 50000 or fraud_score >= 0.5:
        return 'complex'
    # Simple: clean auto-approve or clear auto-deny (low fraud, straightforward)
    elif status in ('approved', 'denied') and fraud_score < 0.3 and claim_amount < 50000:
        return 'simple'
    # Standard: everything else
    else:
        return 'standard'


def _calc_variable_cost(profile):
    """Calculate variable per-claim cost from a complexity profile."""
    bedrock = (profile['input_tokens'] / 1000 * BEDROCK_COST_PER_1K_INPUT_TOKENS +
               profile['output_tokens'] / 1000 * BEDROCK_COST_PER_1K_OUTPUT_TOKENS)
    lam = (LAMBDA_COST_PER_INVOCATION +
           LAMBDA_COST_PER_GB_SECOND * LAMBDA_MEMORY_GB * profile['lambda_duration_sec'])
    agentcore = profile['agentcore_sessions'] * AGENTCORE_COST_PER_SESSION
    return bedrock + lam + agentcore + profile['adjuster_cost']


def _calc_agentcore_monthly_estimate():
    """Estimated monthly AgentCore cost at production volume."""
    # At 1,000 claims/month with avg 4 sessions/claim = 4,000 sessions
    avg_sessions_per_claim = 4
    return PRODUCTION_MONTHLY_VOLUME * avg_sessions_per_claim * AGENTCORE_COST_PER_SESSION


class DecimalEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, Decimal):
            return int(o) if o == int(o) else float(o)
        return super().default(o)


def response(status_code, body):
    return {
        'statusCode': status_code,
        'headers': CORS_HEADERS,
        'body': json.dumps(body, cls=DecimalEncoder),
    }


def _get_user_info(event):
    """Extract user identity and groups from Cognito authorizer."""
    claims = event.get('requestContext', {}).get('authorizer', {}).get('claims', {})
    return {
        'username': claims.get('cognito:username', claims.get('sub', 'unknown')),
        'groups': claims.get('cognito:groups', ''),
    }


def _require_group(event, allowed_groups):
    """Check if user belongs to one of the allowed groups. Returns error response or None."""
    user_info = _get_user_info(event)
    user_groups = user_info.get('groups', '')
    for group in allowed_groups:
        if group.lower() in user_groups.lower():
            return None
    return response(403, {'error': 'Forbidden: insufficient permissions'})


def handler(event, context):
    try:
        http_method = event.get('httpMethod', '')
        path = event.get('path', '')

        if http_method == 'OPTIONS':
            return response(200, {})

        # Role check — only Adjusters and BusinessUsers can access metrics
        auth_err = _require_group(event, ['Adjusters', 'BusinessUsers'])
        if auth_err:
            return auth_err

        if 'dashboard' in path:
            return get_dashboard_metrics()
        elif 'breakdown' in path:
            return get_claims_breakdown()
        else:
            return response(404, {'error': 'Not found'})
    except Exception as e:
        logger.exception("Unhandled error in metrics handler")
        return response(500, {'error': 'An internal error occurred. Please try again.'})


def get_dashboard_metrics():
    """Get comprehensive dashboard metrics from claims data."""
    result = claims_table.scan()
    claims = result.get('Items', [])

    total_claims = len(claims)

    status_counts = defaultdict(int)
    fraud_detected = 0
    agent_invocations = 0
    processing_times = []
    total_input_tokens = 0
    total_output_tokens = 0
    total_claim_amount = 0
    total_approved_amount = 0
    touches_list = []

    # Complexity buckets
    complexity_counts = {'simple': 0, 'standard': 0, 'complex': 0}
    complexity_claims = {'simple': [], 'standard': [], 'complex': []}

    for claim in claims:
        status = str(claim.get('status', 'unknown')).lower()
        status_counts[status] += 1
        claim_amount = float(claim.get('claimAmount', 0))
        total_claim_amount += claim_amount

        if status == 'approved':
            total_approved_amount += claim_amount

        # Classify complexity
        complexity = _classify_claim_complexity(claim)
        complexity_counts[complexity] += 1
        complexity_claims[complexity].append(claim)

        # Count AI-processed claims
        if claim.get('processingDetails'):
            agent_invocations += 1
            try:
                details = json.loads(claim['processingDetails']) if isinstance(claim['processingDetails'], str) else claim['processingDetails']
                fraud_score = float(details.get('fraud_score', 0))
                if fraud_score >= 0.7:
                    fraud_detected += 1
                total_input_tokens += int(details.get('input_tokens', 1500))
                total_output_tokens += int(details.get('output_tokens', 500))
            except (json.JSONDecodeError, ValueError, TypeError):
                total_input_tokens += 1500
                total_output_tokens += 500

        # Processing times for decided claims
        if status in ('approved', 'denied', 'escalated'):
            submitted = int(claim.get('submittedAt', 0))
            updated = int(claim.get('updatedAt', 0))
            if submitted and updated and updated > submitted:
                processing_times.append(updated - submitted)

        # Touches per claim
        touches = 1
        if claim.get('processingDetails'):
            touches += 1
        if status == 'escalated':
            touches += 1
        if claim.get('adjusterNotes'):
            touches += 1
        touches_list.append(touches)

    approved = status_counts.get('approved', 0)
    denied = status_counts.get('denied', 0)
    escalated = status_counts.get('escalated', 0)
    pending = status_counts.get('submitted', 0) + status_counts.get('processing', 0)

    avg_processing_time_ms = sum(processing_times) / len(processing_times) if processing_times else 0
    avg_processing_time_sec = avg_processing_time_ms / 1000.0

    # STP rate
    auto_decided = 0
    for claim in claims:
        status = str(claim.get('status', '')).lower()
        if status in ('approved', 'denied') and claim.get('processingDetails'):
            if not claim.get('adjusterNotes'):
                auto_decided += 1
    stp_rate = (auto_decided / total_claims * 100) if total_claims > 0 else 0

    # ── Cost by Complexity ──
    # AgentCore is consumption-based (pay per session), not fixed monthly
    agentcore_monthly_est = _calc_agentcore_monthly_estimate()

    cost_by_complexity = {}
    for level in ('simple', 'standard', 'complex'):
        profile = COMPLEXITY_PROFILES[level]
        per_claim = _calc_variable_cost(profile)
        cost_by_complexity[level] = {
            'count': complexity_counts[level],
            'pct': round(complexity_counts[level] / total_claims * 100, 1) if total_claims > 0 else 0,
            'totalPerClaim': round(per_claim, 2),
        }

    # Total AI infrastructure cost (excludes adjuster human cost)
    total_ai_cost = 0
    for level in ('simple', 'standard', 'complex'):
        profile = COMPLEXITY_PROFILES[level]
        ai_only_cost = _calc_variable_cost(profile) - profile.get('adjuster_cost', 0)
        total_ai_cost += complexity_counts[level] * ai_only_cost

    # AI handles X% without human
    ai_auto_pct = round((complexity_counts['simple'] + complexity_counts['standard']) / total_claims * 100, 1) if total_claims > 0 else 0

    # Claim Leakage
    claim_leakage = 0
    if total_claim_amount > 0 and total_approved_amount > 0:
        claim_leakage = round((total_approved_amount / total_claim_amount) * 100, 1)

    # Cycle times
    first_contact_time_sec = avg_processing_time_sec
    escalated_times = []
    for claim in claims:
        status = str(claim.get('status', '')).lower()
        if status == 'escalated' or claim.get('adjusterNotes'):
            submitted = int(claim.get('submittedAt', 0))
            updated = int(claim.get('updatedAt', 0))
            if submitted and updated and updated > submitted:
                delta_sec = (updated - submitted) / 1000.0
                escalated_times.append(delta_sec)
    # If escalated claims exist but none have adjuster action yet,
    # the cycle time is the AI processing time (still valid, not N/A)
    if escalated_times:
        escalated_cycle_time = sum(escalated_times) / len(escalated_times)
    elif complexity_counts.get('complex', 0) > 0:
        # Fallback: use avg processing time for escalated claims that haven't been updated
        escalated_cycle_time = avg_processing_time_sec if avg_processing_time_sec > 0 else -1
    else:
        escalated_cycle_time = 0

    avg_touches = sum(touches_list) / len(touches_list) if touches_list else 0

    # Token usage
    total_tokens = total_input_tokens + total_output_tokens
    avg_tokens_per_claim = total_tokens / agent_invocations if agent_invocations > 0 else 0

    # Bedrock cost from actual tokens
    bedrock_cost = (total_input_tokens / 1000 * BEDROCK_COST_PER_1K_INPUT_TOKENS +
                    total_output_tokens / 1000 * BEDROCK_COST_PER_1K_OUTPUT_TOKENS)

    # AgentCore total cost from actual claims (sum sessions across complexity tiers)
    agentcore_total_cost = sum(
        complexity_counts[level] * COMPLEXITY_PROFILES[level]['agentcore_sessions'] * AGENTCORE_COST_PER_SESSION
        for level in ('simple', 'standard', 'complex')
    )

    # Lambda total cost from actual claims
    lambda_total_cost = sum(
        complexity_counts[level] * (LAMBDA_COST_PER_INVOCATION + LAMBDA_COST_PER_GB_SECOND * LAMBDA_MEMORY_GB * COMPLEXITY_PROFILES[level]['lambda_duration_sec'])
        for level in ('simple', 'standard', 'complex')
    )

    # Recent claims
    recent_claims = []
    sorted_claims = sorted(claims, key=lambda x: int(x.get('submittedAt', 0)), reverse=True)
    for claim in sorted_claims[:20]:
        recent_claims.append({
            'claimId': claim.get('claimId', ''),
            'policyHolderName': claim.get('policyHolderName', ''),
            'policyNumber': claim.get('policyNumber', ''),
            'claimAmount': claim.get('claimAmount', 0),
            'status': claim.get('status', 'unknown'),
            'submittedAt': claim.get('submittedAt', 0),
            'aiInsights': claim.get('aiInsights', ''),
        })

    return response(200, {
        'totalClaims': total_claims,
        'approvedClaims': approved,
        'deniedClaims': denied,
        'escalatedClaims': escalated,
        'pendingClaims': pending,
        'flaggedClaims': escalated + fraud_detected,
        'avgProcessingTime': round(avg_processing_time_sec, 1),
        'stpRate': round(stp_rate, 1),
        'agentInvocations': agent_invocations,
        'fraudDetected': fraud_detected,
        'statusBreakdown': dict(status_counts),
        'recentClaims': recent_claims,
        # Cost by complexity
        'costByComplexity': cost_by_complexity,
        'aiAutoHandledPct': ai_auto_pct,
        'agentcoreMonthlyEst': round(agentcore_monthly_est, 2),
        'agentcorePerClaim': round(AGENTCORE_COST_PER_SESSION * 4, 4),  # avg 4 sessions/claim
        'totalAiCost': round(total_ai_cost, 4),
        # Other metrics
        'claimLeakage': claim_leakage,
        'reserveAccuracy': 0,
        'firstContactTime': round(first_contact_time_sec, 1),
        'csatScore': 0,
        'reopenedRate': 0,
        'claimCycleTime': round(avg_processing_time_sec, 1),
        'escalatedCycleTime': round(escalated_cycle_time, 1),
        'touchesPerClaim': round(avg_touches, 1),
        'capacityScalability': 1000,
        'systemLatency': round(avg_processing_time_sec, 1),
        'totalTokens': total_tokens,
        'inputTokens': total_input_tokens,
        'outputTokens': total_output_tokens,
        'avgTokensPerClaim': round(avg_tokens_per_claim, 0),
        'bedrockCost': round(bedrock_cost, 4),
        'agentcoreTotalCost': round(agentcore_total_cost, 4),
        'lambdaTotalCost': round(lambda_total_cost, 6),
    })


def get_claims_breakdown():
    """Get detailed claims breakdown by amount."""
    result = claims_table.scan()
    claims = result.get('Items', [])

    amount_breakdown = {
        '0-50k': 0,
        '50k-100k': 0,
        '100k-250k': 0,
        '250k-500k': 0,
        '500k+': 0,
    }

    for claim in claims:
        amount = int(claim.get('claimAmount', 0))
        if amount < 50000:
            amount_breakdown['0-50k'] += 1
        elif amount < 100000:
            amount_breakdown['50k-100k'] += 1
        elif amount < 250000:
            amount_breakdown['100k-250k'] += 1
        elif amount < 500000:
            amount_breakdown['250k-500k'] += 1
        else:
            amount_breakdown['500k+'] += 1

    return response(200, {
        'byAmount': amount_breakdown,
        'totalClaims': len(claims),
    })
