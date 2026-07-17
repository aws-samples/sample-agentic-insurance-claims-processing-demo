# Deployment Artifacts

---

## Important Notice

All deployment documentation has been consolidated into:

**`../DEPLOYMENT_GUIDE.md`** (in the root directory)

This single comprehensive guide contains:
- Prerequisites checklist
- Manual deployment steps for all phases
- Troubleshooting section
- Cleanup instructions
- Cost tracking
- Version history

---

## Files in This Folder

These files supplement the main deployment guide:

- `00_PRE_DEPLOYMENT_CHECKLIST.md` - Prerequisites verification (includes OpenSearch Python packages)
- `01_DEPLOYMENT_STEPS.md` - Step-by-step deployment (supplementary, consolidated into DEPLOYMENT_GUIDE.md)
- `03_TROUBLESHOOTING.md` - **Detailed lessons learned from actual deployments** (v4.0.0, 27 lessons documented)

---

## Quick Reference

### Deployed Environment

After deployment, your environment-specific values will be in `../backend/infrastructure/outputs.json`.

| Resource | Value |
|----------|-------|
| Frontend | `https://<YOUR_CLOUDFRONT_DOMAIN>.cloudfront.net` |
| API | `https://<YOUR_API_GATEWAY_ID>.execute-api.<YOUR_REGION>.amazonaws.com/prod/` |
| AI Model | Claude Sonnet 4 (`us.anthropic.claude-sonnet-4-20250514-v1:0`) |
| Region | us-east-1 (default) |

### Test Users
| Username | Password | Role |
|----------|----------|------|
| claimant1 | Test123!Pass | Claimant |
| adjuster1 | Test123!Pass | Adjuster |
| business1 | Test123!Pass | Business |

---

**Use `../DEPLOYMENT_GUIDE.md` for all deployment needs.**
