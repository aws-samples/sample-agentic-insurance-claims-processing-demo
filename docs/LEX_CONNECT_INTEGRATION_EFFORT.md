# Amazon Lex & Amazon Connect Integration — Effort Analysis

Detailed effort estimate for integrating Amazon Lex V2 and Amazon Connect into the CCOE Insurance claims processing system, upgrading from a simple FAQ chatbot to a full conversational AI platform with voice-based contact center support.

---

## Current State Assessment

### What Exists Today

**Chat Lambda** (`chat_handler.py`):
- Direct Bedrock InvokeModel call to Claude Sonnet 4 with a static system prompt
- Stateless — conversation history is passed from the frontend on each request (last 6 messages)
- Single intent: free-form FAQ about claims process, required documents, timelines
- No slot filling, no transactional actions (can't file a claim, check status, or upload docs)
- No sentiment detection or escalation to a human

**ChatWidget** (`ChatWidget.tsx`):
- Custom React floating widget, claimant-only (role-gated)
- Auto-opens after 1.5 seconds with empathetic greeting
- 4 hardcoded suggestion chips
- Text-only, no voice, no file sharing in chat

**Claims API**:
- Full CRUD: `POST /claims`, `GET /claims/{id}`, `POST /claims/{id}/documents`, `POST /claims/{id}/approve|deny`
- Cognito JWT auth on all endpoints
- Async AI processing via Lambda self-invoke

### What's Missing
- No voice channel (phone/IVR)
- No structured intent recognition (everything goes through a single LLM prompt)
- No transactional bot actions (can't file a claim or check status conversationally)
- No human escalation path from chat
- No contact center for adjusters to handle live calls
- No call recording, transcription, or analytics
- No unified conversation history across channels

---

## Integration Architecture

```
                         ┌──────────────────────────┐
                         │      Claimant Channels    │
                         │  Web Chat │ Phone │ SMS   │
                         └────────────┬───────────────┘
                                      │
                         ┌────────────▼───────────────┐
                         │      Amazon Connect         │
                         │  Instance + Contact Flows   │
                         │  ┌───────────────────────┐  │
                         │  │ IVR Flow              │  │
                         │  │ "Press 1 for new claim│  │
                         │  │  Press 2 for status   │  │
                         │  │  Press 3 for agent"   │  │
                         │  └───────────┬───────────┘  │
                         │              │              │
                         │  ┌───────────▼───────────┐  │
                         │  │ Amazon Lex V2 Bot     │  │
                         │  │ (voice + text)        │  │
                         │  │                       │  │
                         │  │ Intents:              │  │
                         │  │  CheckClaimStatus     │  │
                         │  │  FileNewClaim         │  │
                         │  │  GetRequiredDocuments  │  │
                         │  │  ExplainDecision      │  │
                         │  │  SpeakToAdjuster      │  │
                         │  │  GeneralFAQ (fallback)│  │
                         │  └───────────┬───────────┘  │
                         │              │              │
                         │  ┌───────────▼───────────┐  │
                         │  │ Contact Lens          │  │
                         │  │ Real-time sentiment   │  │
                         │  │ Call analytics        │  │
                         │  │ Supervisor alerts     │  │
                         │  └───────────────────────┘  │
                         │                             │
                         │  Queues:                    │
                         │   Claimant Self-Service     │
                         │   Adjuster Review           │
                         │   Escalation                │
                         └────────────┬───────────────┘
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
          ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
          │ Lex Fulfill- │  │ Existing     │  │ Connect      │
          │ ment Lambdas │  │ Claims API   │  │ Data Storage │
          │ (new)        │→ │ (unchanged)  │  │ S3 + KDS     │
          └──────────────┘  └──────────────┘  └──────────────┘
```

### Key Design Decisions

1. **Lex V2 as the NLU layer** — replaces the raw Bedrock InvokeModel call for structured interactions. The existing Chat Lambda stays as a fallback for free-form questions that don't match any Lex intent (routed to the `GeneralFAQ` fallback intent which still calls Claude).

2. **Connect as the orchestration layer** — manages all channels (voice, web chat, SMS). The existing React ChatWidget gets replaced with the Connect hosted chat widget, giving unified conversation history.

3. **Fulfillment Lambdas call the existing Claims API** — no changes to the core claims handler. Lex fulfillment Lambdas act as thin adapters that translate Lex slot values into API calls.

4. **Connect Contact Lens for analytics** — real-time sentiment, call transcription, and supervisor alerts. No custom build needed.

---

## Amazon Lex V2 — Bot Design

### Intents

| Intent | Slots | Fulfillment | Example Utterances |
|--------|-------|-------------|-------------------|
| `CheckClaimStatus` | `claimId` (required) | Lambda → `GET /claims/{id}` | "What's the status of my claim?", "Check claim CLM-20260306-abc" |
| `FileNewClaim` | `policyNumber`, `beneficiaryName`, `causeOfDeath`, `claimAmount` (all required) | Lambda → `POST /claims` | "I need to file a claim", "Submit a new death benefits claim" |
| `GetRequiredDocuments` | `claimType` (optional) | Lambda (static response + Claude enrichment) | "What documents do I need?", "What should I upload?" |
| `ExplainDecision` | `claimId` (required) | Lambda → `GET /claims/{id}` → parse `aiInsights` | "Why was my claim denied?", "Explain the decision on my claim" |
| `SpeakToAdjuster` | none | Connect queue transfer | "I want to talk to a person", "Transfer me to an agent" |
| `GeneralFAQ` | none (fallback) | Lambda → Bedrock InvokeModel (existing Claude prompt) | Anything that doesn't match above intents |

### Slot Types

| Slot | Type | Validation |
|------|------|------------|
| `claimId` | Custom (regex: `CLM-\d{8}-[a-f0-9]+`) | Lambda validates against DynamoDB |
| `policyNumber` | Custom (regex: `LIP-\d{4}-\d{6}`) | Lambda validates against POLICY_DATABASE |
| `beneficiaryName` | `AMAZON.FirstName` + `AMAZON.LastName` | None |
| `causeOfDeath` | Custom (enum: natural, accident, illness, other) | None |
| `claimAmount` | `AMAZON.Number` | Lambda validates > 0 and < face value |

### Conversation Flow: FileNewClaim

```
Bot:  I can help you file a death benefits claim. I'll need a few details.
      What is the policy number? (It starts with LIP-)
User: LIP-2019-087234
Bot:  Got it. What is the name of the beneficiary filing this claim?
User: Margaret Mitchell
Bot:  What was the cause of death?
User: Heart attack
Bot:  And what is the claim amount you're requesting?
User: $25,000
Bot:  Let me confirm: Policy LIP-2019-087234, beneficiary Margaret Mitchell,
      cause of death heart attack, claim amount $25,000. Shall I submit this?
User: Yes
Bot:  Your claim has been submitted. Your claim ID is CLM-20260309-d4e5f6.
      You can track its status in the portal or ask me anytime.
      Our AI system will review it shortly — most decisions come within minutes.
```

---

## Amazon Connect — Contact Center Design

### Instance Configuration

| Setting | Value |
|---------|-------|
| Instance alias | `ccoe-insurance-claims` |
| Identity | SAML/Cognito federation (adjusters use existing Cognito credentials) |
| Data storage | S3 bucket for call recordings and chat transcripts |
| Telephony | Claimed phone number (toll-free or DID) |
| Hours of operation | Business hours (configurable) + after-hours IVR |

### Contact Flows

**1. Main IVR Flow** (`MainInboundFlow`)
```
→ Play prompt: "Thank you for calling CCOE Insurance claims department."
→ Get customer input (DTMF):
    1 → "File or check a claim" → Transfer to Lex bot
    2 → "Speak with a claims adjuster" → Queue: AdjusterReview
    3 → "Repeat options" → Loop
    Timeout/Error → Transfer to Lex bot (voice self-service)
```

**2. Lex Bot Flow** (`LexSelfServiceFlow`)
```
→ Get customer input (Lex V2 bot)
→ On intent SpeakToAdjuster → Transfer to queue: AdjusterReview
→ On Lex error/timeout → Transfer to queue: Escalation
→ On successful fulfillment → Play "Is there anything else?" → Loop or disconnect
```

**3. Adjuster Queue Flow** (`AdjusterQueueFlow`)
```
→ Check queue metrics (agents available?)
    Yes → Transfer to agent
    No  → Play "All adjusters are busy. Estimated wait: X minutes."
          → Offer callback: "Press 1 for a callback, or hold"
```

**4. After-Hours Flow**
```
→ Play "Our office is currently closed. Hours are Mon-Fri 8am-6pm."
→ Transfer to Lex bot for self-service
→ Or: "Leave a voicemail" → S3 recording
```

### Queues & Routing Profiles

| Queue | Agents | Priority |
|-------|--------|----------|
| ClaimantSelfService | Lex bot (automated) | Default |
| AdjusterReview | Adjusters (Cognito `Adjusters` group) | High |
| Escalation | Senior adjusters | Urgent |

### Contact Lens Configuration
- Real-time sentiment analysis (positive/negative/neutral)
- Supervisor alert when sentiment drops below threshold
- Post-call analytics: talk time, hold time, sentiment trend
- Automatic call categorization (new claim, status check, complaint, escalation)
- PII redaction in transcripts (SSN, account numbers)

---

## Work Breakdown

### Stream 1: Amazon Lex V2 Bot (CDK + Bot Definition)

| Task | Description | Effort | Complexity |
|------|-------------|--------|------------|
| 1.1 | Lex V2 bot resource in CDK (bot, intents, slot types, bot alias) | 3 days | High |
| 1.2 | `CheckClaimStatus` intent — slot elicitation, confirmation, fulfillment Lambda | 2 days | Medium |
| 1.3 | `FileNewClaim` intent — 4 required slots, confirmation prompt, fulfillment Lambda | 3 days | High |
| 1.4 | `GetRequiredDocuments` intent — static + Claude-enriched response | 1 day | Low |
| 1.5 | `ExplainDecision` intent — parses `aiInsights` and `processingDetails` from DynamoDB | 1.5 days | Medium |
| 1.6 | `SpeakToAdjuster` intent — Connect queue transfer action | 0.5 days | Low |
| 1.7 | `GeneralFAQ` fallback intent — routes to existing Claude prompt | 1 day | Low |
| 1.8 | Lex bot testing, utterance tuning, slot validation edge cases | 2 days | Medium |
| **Subtotal** | | **14 days** | |

Key complexity in 1.1: Lex V2 CDK support uses L1 constructs (`CfnBot`, `CfnBotAlias`, `CfnBotVersion`). The bot definition JSON is verbose — each intent needs utterances, slots, slot priorities, prompts, confirmation prompts, and fulfillment configuration. No L2 abstracts exist yet.

Key complexity in 1.3: `FileNewClaim` is a multi-turn conversation with 4 required slots. Each slot needs elicitation prompts, re-prompt on invalid input, and the confirmation step must summarize all collected values. The fulfillment Lambda must handle Cognito auth context (the caller's identity) to associate the claim with the right user.

### Stream 2: Lex Fulfillment Lambdas

| Task | Description | Effort | Complexity |
|------|-------------|--------|------------|
| 2.1 | Shared Lex fulfillment handler (event parsing, response formatting, error handling) | 1.5 days | Medium |
| 2.2 | `CheckClaimStatus` handler — DynamoDB query, format status + AI insights for voice/text | 1 day | Low |
| 2.3 | `FileNewClaim` handler — validate slots, call Claims API, return claim ID | 2 days | Medium |
| 2.4 | `ExplainDecision` handler — parse `processingDetails` JSON, summarize for voice | 1.5 days | Medium |
| 2.5 | `GeneralFAQ` handler — proxy to existing Bedrock InvokeModel with Claude prompt | 0.5 days | Low |
| 2.6 | IAM roles for Lex fulfillment Lambdas (DynamoDB read, Claims API invoke, Bedrock) | 1 day | Medium |
| **Subtotal** | | **7.5 days** | |

Key detail on 2.1: Lex V2 Lambda fulfillment events have a specific format (`sessionState`, `interpretations`, `inputTranscript`). The response must include `dialogAction` (close, delegate, elicitSlot) and `messages`. This is different from API Gateway Lambda events — a shared handler module avoids duplication.

Key detail on 2.3: The `FileNewClaim` fulfillment Lambda can't use the existing Cognito-authed API Gateway endpoint directly (Lex doesn't pass JWT tokens). It needs to call DynamoDB directly or use IAM-authed internal API calls. Simplest approach: the Lambda writes to DynamoDB directly using the same logic as `create_claim()` in the claims handler, then triggers the async AI processing.

### Stream 3: Amazon Connect Instance & Contact Flows

| Task | Description | Effort | Complexity |
|------|-------------|--------|------------|
| 3.1 | Connect instance creation (CDK or console), phone number claim, hours of operation | 2 days | Medium |
| 3.2 | Main IVR contact flow (DTMF menu, Lex integration, queue transfers) | 2 days | Medium |
| 3.3 | Lex bot integration in Connect (associate bot, configure voice settings) | 1 day | Medium |
| 3.4 | Adjuster queue, routing profile, agent hierarchy | 1.5 days | Medium |
| 3.5 | After-hours flow with voicemail to S3 | 1 day | Low |
| 3.6 | Callback queue flow (offer callback when wait time exceeds threshold) | 1 day | Medium |
| 3.7 | Contact Lens enablement (real-time analytics, sentiment, PII redaction) | 1 day | Low |
| 3.8 | Connect data storage configuration (S3 for recordings, Kinesis for CTRs) | 1 day | Low |
| **Subtotal** | | **10.5 days** | |

Key complexity in 3.1: Connect CDK support is limited. `aws-cdk-lib/aws-connect` has L1 constructs only (`CfnInstance`, `CfnContactFlow`, `CfnQueue`). Contact flows are defined as JSON — the flow designer in the Connect console is much easier for initial design, then export to JSON for CDK. Recommended approach: design flows in console first, then codify.

Key complexity in 3.3: Lex V2 bot integration with Connect requires the bot to be in the same region, the Connect instance must have the Lex bot associated, and the contact flow uses a "Get customer input" block with Lex V2 configuration. Voice settings (voice ID, language) are configured at the Connect level.

### Stream 4: Web Chat Migration (Connect Chat Widget)

| Task | Description | Effort | Complexity |
|------|-------------|--------|------------|
| 4.1 | Connect chat widget integration in React app (replace custom ChatWidget) | 2 days | Medium |
| 4.2 | Connect chat contact flow (routes to Lex bot, escalation to agent) | 1 day | Low |
| 4.3 | Chat widget styling to match existing Tailwind design system | 1 day | Low |
| 4.4 | Cognito identity passthrough (associate chat contact with logged-in claimant) | 1.5 days | High |
| 4.5 | Preserve auto-open behavior and suggestion chips in Connect widget | 0.5 days | Low |
| **Subtotal** | | **6 days** | |

Key complexity in 4.4: The current ChatWidget knows the user's Cognito identity (JWT token). Connect's hosted chat widget uses its own identity mechanism. To link a chat session to a Cognito user (so the Lex bot can look up "my claims"), you need to pass customer attributes via the Connect `StartChatContact` API with the Cognito user ID as a contact attribute. The Lex fulfillment Lambda then uses this attribute to query DynamoDB for that user's claims.

### Stream 5: Adjuster Agent Desktop

| Task | Description | Effort | Complexity |
|------|-------------|--------|------------|
| 5.1 | Connect CCP (Contact Control Panel) embedded in Adjuster Workbench | 2 days | Medium |
| 5.2 | Agent Assist panel — show claim details and AI insights when adjuster accepts a call | 2 days | High |
| 5.3 | Screen pop: auto-load claim in Adjuster Workbench when call arrives with claim ID | 1.5 days | Medium |
| 5.4 | After-call work: adjuster notes saved to DynamoDB claim record | 1 day | Low |
| **Subtotal** | | **6.5 days** | |

Key complexity in 5.2: When an adjuster accepts a call that was escalated from the Lex bot, the contact attributes include the `claimId`. The Agent Assist panel needs to fetch claim details from the API and display AI insights, fraud score, and document findings alongside the call. This requires a Connect Streams API integration in the React app that listens for contact events and triggers data fetches.

### Stream 6: CDK Infrastructure

| Task | Description | Effort | Complexity |
|------|-------------|--------|------------|
| 6.1 | New CDK stack: `LifeInsuranceContactCenterStack` (Connect, Lex, fulfillment Lambdas) | 3 days | High |
| 6.2 | Lex bot definition as CDK L1 constructs (verbose JSON for intents, slots, utterances) | 2 days | High |
| 6.3 | Connect contact flows as CDK L1 constructs (JSON flow definitions) | 2 days | High |
| 6.4 | IAM roles: Lex → Lambda, Connect → Lex, Connect → S3/Kinesis | 1 day | Medium |
| 6.5 | Update deploy.sh with contact center deployment phase | 0.5 days | Low |
| **Subtotal** | | **8.5 days** | |

Key note on 6.1–6.3: Both Lex V2 and Connect have limited CDK L2 support. The bot definition and contact flow JSON are large and complex. A pragmatic approach: create the bot and flows in the AWS console first, export the JSON definitions, then wrap them in CDK L1 constructs for reproducibility. This avoids writing hundreds of lines of JSON by hand.

### Stream 7: Testing & Integration

| Task | Description | Effort | Complexity |
|------|-------------|--------|------------|
| 7.1 | Lex bot testing — all intents, slot validation, edge cases, fallback behavior | 2 days | Medium |
| 7.2 | Voice testing — call the Connect number, test IVR menu, Lex voice recognition | 2 days | Medium |
| 7.3 | Web chat testing — Connect widget in React, escalation to agent, identity passthrough | 1.5 days | Medium |
| 7.4 | Agent desktop testing — CCP, screen pop, Agent Assist, after-call work | 1.5 days | Medium |
| 7.5 | End-to-end: file a claim by voice → check status by chat → escalate to adjuster | 1 day | Medium |
| 7.6 | Contact Lens validation — sentiment detection, transcription accuracy, PII redaction | 1 day | Low |
| 7.7 | Documentation updates | 0.5 days | Low |
| **Subtotal** | | **9.5 days** | |

---

## Total Effort Summary

| Stream | Days | Can Parallelize? |
|--------|------|-----------------|
| 1. Lex V2 Bot Definition | 14.0 | Start first |
| 2. Fulfillment Lambdas | 7.5 | Parallel with Stream 1 |
| 3. Connect Instance & Flows | 10.5 | Parallel with Streams 1–2 |
| 4. Web Chat Migration | 6.0 | After Streams 1+3 |
| 5. Adjuster Agent Desktop | 6.5 | After Stream 3 |
| 6. CDK Infrastructure | 8.5 | After Streams 1–3 stable |
| 7. Testing & Integration | 9.5 | After all streams |
| **Total (sequential)** | **62.5 days** | |
| **Total (with parallelism)** | **~35–40 days** | Streams 1+2+3 parallel, then 4+5, then 6+7 |

### Team Size Recommendation

- 1 conversational AI engineer (Streams 1, 2): ~4 weeks
- 1 Connect/telephony engineer (Streams 3, 5): ~3.5 weeks
- 1 frontend engineer (Streams 4, 5): ~2.5 weeks
- 1 infra/CDK engineer (Stream 6): ~2 weeks
- Overlap testing (Stream 7): ~2 weeks

With a 2-person team: ~8–10 weeks  
With a 3-person team: ~6–7 weeks  
Solo developer: ~13–15 weeks

---

## AWS Cost Impact

### New Monthly Costs

| Service | Estimated Cost | Notes |
|---------|---------------|-------|
| Amazon Connect (voice) | $30–80/month | $0.018/min inbound + $0.018/min agent usage; ~500 min/month at demo scale |
| Amazon Connect (chat) | $5–15/month | $0.004/message; ~2,000 messages/month |
| Amazon Lex V2 | $15–40/month | $0.004/text request, $0.0065/voice request; ~5,000 requests/month |
| Connect Contact Lens | $15–30/month | $0.015/min analyzed; ~500 min/month |
| Phone number (toll-free) | $2/month | $0.06/min inbound DID |
| S3 (recordings + transcripts) | $2–5/month | Call recordings at ~1MB/min |
| Lambda (fulfillment) | $1–3/month | Lex fulfillment invocations |
| **Total Additional** | **$70–175/month** | |

### Cost at Scale (1,000 claims/month)

| Service | Estimated Cost |
|---------|---------------|
| Connect voice (est. 2,000 min) | $72/month |
| Connect chat (est. 10,000 messages) | $40/month |
| Lex (est. 20,000 requests) | $80–130/month |
| Contact Lens (2,000 min) | $30/month |
| Other (S3, Lambda, phone) | $10–15/month |
| **Total** | **$230–290/month** |

### Cost Comparison: Current vs Integrated

| Component | Current Cost | With Lex + Connect |
|-----------|-------------|-------------------|
| Chat (Bedrock direct) | ~$0.01/conversation | ~$0.02–0.04/conversation (Lex + fallback to Bedrock) |
| Voice support | $0 (not available) | ~$0.07/min (Connect + Lex + Contact Lens) |
| Agent desktop | $0 (web-only) | Included in Connect pricing |
| Analytics | $0 (custom dashboard) | ~$0.015/min (Contact Lens) |

---

## What You Keep vs What You Replace

| Current Component | After Integration | Notes |
|-------------------|-------------------|-------|
| `chat_handler.py` (Lambda) | Kept as Lex `GeneralFAQ` fallback | Still handles free-form questions via Claude |
| `ChatWidget.tsx` (React) | Replaced by Connect hosted chat widget | Unified chat across web + voice |
| `/chat` API endpoint | Kept for backward compatibility | Mobile apps or other consumers can still use it |
| `SYSTEM_PROMPT` in chat handler | Reused in `GeneralFAQ` fulfillment Lambda | Same empathetic FAQ knowledge |
| Claims API (`/claims/*`) | Unchanged | Lex fulfillment Lambdas call it or DynamoDB directly |
| Adjuster Workbench | Enhanced with CCP + Agent Assist | Existing UI stays, CCP panel added |
| Cognito auth | Extended to Connect | Adjusters use same credentials for CCP |

---

## Phased Rollout Recommendation

Given the size of this integration, a phased approach reduces risk:

### Phase A: Lex Bot Only (Weeks 1–4)
- Build the Lex V2 bot with all 6 intents
- Build fulfillment Lambdas
- Integrate Lex into the existing React ChatWidget via Lex Runtime V2 API (not Connect yet)
- This gives structured conversations without the Connect dependency
- Deliverable: smarter chatbot that can file claims and check status conversationally

### Phase B: Connect Chat (Weeks 4–6)
- Stand up Connect instance
- Replace React ChatWidget with Connect hosted chat widget
- Route chat through Connect → Lex → fulfillment
- Add escalation to human adjuster via chat
- Deliverable: unified chat with human escalation

### Phase C: Connect Voice (Weeks 6–9)
- Claim phone number, build IVR flows
- Integrate Lex bot for voice self-service
- Build adjuster queue and routing profiles
- Enable Contact Lens
- Deliverable: full voice channel with IVR + Lex + agent routing

### Phase D: Agent Desktop (Weeks 9–11)
- Embed CCP in Adjuster Workbench
- Build Agent Assist panel with screen pop
- After-call work integration
- Deliverable: adjusters handle calls within the existing workbench

### Phase E: CDK Codification + Hardening (Weeks 11–13)
- Export all Connect/Lex configurations to CDK
- End-to-end testing across all channels
- Documentation
- Deliverable: reproducible infrastructure-as-code deployment

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Lex V2 CDK support is L1 only | Bot definition JSON is verbose and error-prone | Design in console first, export JSON, wrap in CDK |
| Connect instance setup requires manual steps | Phone number claiming, SAML config can't be fully automated | Document manual steps, automate what's possible |
| Voice recognition accuracy for insurance terms | Policy numbers, medical terms may be misheard | Custom slot types with synonyms, confirmation prompts on all critical slots |
| Cognito → Connect identity mapping | Linking chat/call to a logged-in user is non-trivial | Pass Cognito user ID as Connect contact attribute via `StartChatContact` |
| Lex fulfillment auth for Claims API | Lex Lambdas can't use Cognito JWT tokens | Fulfillment Lambdas access DynamoDB directly with IAM roles (bypass API Gateway) |
| Connect pricing at scale | Voice minutes add up with long calls | Optimize IVR to resolve common queries via Lex before reaching an agent |
| Agent adoption | Adjusters need training on CCP | Build CCP into existing Adjuster Workbench (familiar UI) + training docs |

---

## Prerequisites Before Starting

- [ ] Decide on phased vs big-bang rollout (phased recommended)
- [ ] Claim a phone number (toll-free or DID) — requires AWS Support ticket for some number types
- [ ] Decide on Connect identity: SAML federation with Cognito, or Connect-managed users
- [ ] Verify Lex V2 is available in your region (us-east-1: yes)
- [ ] Verify Connect is available in your region (us-east-1: yes)
- [ ] Budget approval for ~$70–175/month additional cost (demo scale)

---

## Comparison with QuickSight Integration

| Dimension | QuickSight | Lex + Connect |
|-----------|-----------|---------------|
| Total effort (sequential) | 36 days | 62.5 days |
| Total effort (parallel) | 22–25 days | 35–40 days |
| Solo developer timeline | 7–8 weeks | 13–15 weeks |
| Monthly cost impact | $27–46 | $70–175 |
| CDK maturity | Medium (Athena/Glue have L2s) | Low (Lex/Connect are L1 only) |
| Business value | Analytics & reporting | New customer channel + agent productivity |
| Risk level | Low | Medium (telephony + NLU complexity) |
| Can be phased? | Yes (pipeline → dashboards → embed) | Yes (Lex → chat → voice → agent desktop) |

---

**This analysis assumes a single-region deployment in us-east-1. Multi-region Connect deployments (global telephony) would significantly increase complexity and cost.**
