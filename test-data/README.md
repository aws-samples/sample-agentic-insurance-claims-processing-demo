# Test Data for End-to-End Claims Processing Demo

## Scenarios

| # | Scenario | Expected Outcome | Amount | Date of Death | Key Trigger |
|---|----------|-----------------|--------|---------------|-------------|
| 1 | Clean low-value claim | STP Auto-Approved | $25,000 | Feb 10, 2026 | All docs valid, low fraud, active policy |
| 2 | Lapsed policy | Auto-Denied | $30,000 | Feb 18, 2026 | Policy expired 6 months ago |
| 3 | High fraud indicators | Auto-Denied | $45,000 | Feb 22, 2026 | Suspicious timing, inconsistent docs |
| 4 | High-value claim | Manual Review | $150,000 | Feb 8, 2026 | Amount >= $50K triggers escalation |
| 5 | Missing documents | Pending Documents | $35,000 | Feb 25, 2026 | No death certificate uploaded |
| 6 | Excluded cause of death | Auto-Denied | $40,000 | Feb 15, 2026 | Suicide within 2-year contestability |
| 7 | Moderate fraud score | Manual Review | $28,000 | Feb 27, 2026 | Fraud score 0.5-0.8 range |

## How to Load

```bash
cd test-data
pip3 install boto3
python3 load_test_data.py
```

## Sample Documents

The `documents/` folder contains AI-friendly text-based sample documents (death certificates, medical records, policy documents, ID cards) for each scenario.
