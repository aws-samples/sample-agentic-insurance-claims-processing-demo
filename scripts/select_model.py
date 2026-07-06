#!/usr/bin/env python3
"""
Model Selection Script for Claims Processing Demo.

Queries Amazon Bedrock for available Claude models, checks access,
and lets the user select which model to use for deployment.
"""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

# ANSI color codes
GREEN = "\033[92m"
YELLOW = "\033[93m"
RED = "\033[91m"
BOLD = "\033[1m"
RESET = "\033[0m"
DIM = "\033[2m"

# Capability tier ranking (higher = more capable)
CAPABILITY_TIERS = {
    "opus": 4,
    "sonnet": 3,
    "haiku": 2,
}

OUTPUT_PATH = Path(__file__).resolve().parent.parent / "backend" / "infrastructure" / "model-config.json"


def parse_args():
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Select an AI model for the Claims Processing Demo deployment."
    )
    parser.add_argument(
        "--non-interactive",
        action="store_true",
        help="Auto-select the recommended model without prompting.",
    )
    parser.add_argument(
        "--region",
        default="us-east-1",
        help="AWS region for Bedrock API calls (default: us-east-1).",
    )
    parser.add_argument(
        "--output-path",
        default=None,
        help="Path to write model-config.json (default: auto-detect from script location).",
    )
    return parser.parse_args()


def get_capability_tier(model_id: str) -> int:
    """Determine capability tier from model ID."""
    model_id_lower = model_id.lower()
    for tier_name, tier_value in CAPABILITY_TIERS.items():
        if tier_name in model_id_lower:
            return tier_value
    return 1  # Unknown tier gets lowest ranking


def extract_version_date(model_id: str) -> str:
    """Extract date string from model ID for recency comparison."""
    parts = model_id.split("-")
    for part in parts:
        if len(part) >= 8 and part[:8].isdigit():
            return part[:8]
    return "00000000"


def get_friendly_name(model_name: str, model_id: str) -> str:
    """Build a friendly display name for the model."""
    if model_name:
        return model_name
    return model_id.split(".")[-1] if "." in model_id else model_id


def check_model_access(client, model_id: str) -> bool:
    """Check if the user has access to a specific model."""
    try:
        response = client.get_foundation_model_availability(modelId=model_id)
        auth_status = response.get("authorizationStatus", "")
        entitlement = response.get("entitlementAvailability", "")
        return auth_status == "AUTHORIZED" and entitlement == "AVAILABLE"
    except (ClientError, Exception):
        return False


def format_eol_date(eol_time) -> str:
    """Format the end-of-life timestamp for display."""
    if not eol_time:
        return "Not specified"
    if isinstance(eol_time, datetime):
        return eol_time.strftime("%Y-%m-%d")
    return str(eol_time)


def sort_models(models: list) -> list:
    """
    Sort models by recommendation priority.

    Order: ACTIVE first, then LEGACY. Within each group, sort by
    capability tier (opus > sonnet > haiku) then recency (newer first).
    Uses Python's stable sort with multiple passes.
    """
    sorted_models = list(models)

    # Pass 1: date descending (newer first) — least significant key first
    sorted_models.sort(
        key=lambda m: extract_version_date(m["modelId"]), reverse=True
    )
    # Pass 2: capability tier descending (opus > sonnet > haiku)
    sorted_models.sort(key=lambda m: -get_capability_tier(m["modelId"]))
    # Pass 3: status (ACTIVE=0, LEGACY=1, other=2) — most significant key last
    sorted_models.sort(
        key=lambda m: (
            0 if m.get("modelLifecycle", {}).get("status", "") == "ACTIVE"
            else (1 if m.get("modelLifecycle", {}).get("status", "") == "LEGACY" else 2)
        )
    )
    return sorted_models


def find_recommended_index(models: list) -> int:
    """
    Determine which model to recommend.

    Prefers the first ACTIVE model (already sorted by tier+recency).
    If none are ACTIVE, picks the LEGACY model with the latest end-of-life.
    """
    active_indices = [
        i for i, m in enumerate(models)
        if m.get("modelLifecycle", {}).get("status", "") == "ACTIVE"
    ]
    if active_indices:
        return active_indices[0]

    # No ACTIVE models — pick LEGACY with latest EOL
    best_idx = 0
    best_eol = ""
    for i, m in enumerate(models):
        eol = m.get("modelLifecycle", {}).get("endOfLifeTime")
        eol_str = format_eol_date(eol) if eol else ""
        if eol_str > best_eol:
            best_eol = eol_str
            best_idx = i
    return best_idx


def main():
    args = parse_args()

    # Resolve output path
    if args.output_path:
        output_path = Path(args.output_path).resolve()
    else:
        output_path = OUTPUT_PATH

    print(f"\n{BOLD}Bedrock Model Selection{RESET}")
    print("=" * 50)
    print(f"Region: {args.region}\n")

    # Initialize Bedrock client
    try:
        client = boto3.client("bedrock", region_name=args.region)
    except Exception as e:
        print(f"{RED}Error: Could not create Bedrock client: {e}{RESET}")
        sys.exit(1)

    # List Anthropic foundation models
    print("Querying available Claude models...")
    try:
        response = client.list_foundation_models(byProvider="anthropic")
    except ClientError as e:
        print(f"{RED}Error listing models: {e}{RESET}")
        sys.exit(1)

    models = response.get("modelSummaries", [])

    # Filter to Claude models only
    claude_models = [m for m in models if "claude" in m.get("modelId", "").lower()]

    if not claude_models:
        print(f"{RED}No Claude models found in region {args.region}.{RESET}")
        sys.exit(1)

    # Check access for each model
    print("Checking model access (this may take a moment)...\n")
    accessible_models = []
    for model in claude_models:
        model_id = model["modelId"]
        if check_model_access(client, model_id):
            accessible_models.append(model)

    if not accessible_models:
        print(f"{RED}No accessible Claude models found.{RESET}")
        print("Ensure you have requested model access in the Bedrock console.")
        sys.exit(1)

    # Sort models by recommendation priority
    accessible_models = sort_models(accessible_models)
    recommended_idx = find_recommended_index(accessible_models)

    # Display table
    print(f"{BOLD}{'#':<4}{'Model Name':<35}{'Model ID':<55}{'Status':<25}{'Rec.'}{RESET}")
    print("-" * 125)

    legacy_warnings = []

    for i, model in enumerate(accessible_models):
        model_id = model["modelId"]
        model_name = get_friendly_name(model.get("modelName", ""), model_id)
        lifecycle = model.get("modelLifecycle", {})
        status = lifecycle.get("status", "UNKNOWN")
        eol_time = lifecycle.get("endOfLifeTime")

        # Format status display
        if status == "ACTIVE":
            status_display = f"{GREEN}ACTIVE{RESET}"
        elif status == "LEGACY":
            eol_str = format_eol_date(eol_time)
            status_display = f"{YELLOW}\u26a0\ufe0f  LEGACY (EOL: {eol_str}){RESET}"
            legacy_warnings.append((model_name, model_id, eol_str))
        else:
            status_display = f"{DIM}{status}{RESET}"

        # Recommendation indicator
        rec_indicator = f" {GREEN}\u2605 recommended{RESET}" if i == recommended_idx else ""

        # Cross-region inference ID for display
        cross_region_id = f"us.{model_id}" if not model_id.startswith("us.") else model_id

        print(f"{i + 1:<4}{model_name:<35}{cross_region_id:<55}{status_display}{rec_indicator}")

    print()

    # Print LEGACY warnings
    for name, mid, eol in legacy_warnings:
        print(
            f"{YELLOW}{BOLD}\u26a0\ufe0f  WARNING:{RESET}{YELLOW} {name} ({mid}) is marked LEGACY by AWS. "
            f"End of life: {eol}. Consider using an ACTIVE model instead.{RESET}"
        )

    if legacy_warnings:
        print()

    # Selection
    if args.non_interactive:
        selected_idx = recommended_idx
        selected_model = accessible_models[selected_idx]
        print("Auto-selecting recommended model (--non-interactive)...")
    else:
        default_display = recommended_idx + 1
        while True:
            try:
                choice = input(
                    f"Select a model [1-{len(accessible_models)}] "
                    f"(Enter for recommended #{default_display}): "
                ).strip()

                if not choice:
                    selected_idx = recommended_idx
                    break

                selected_idx = int(choice) - 1
                if 0 <= selected_idx < len(accessible_models):
                    break
                else:
                    print(f"Please enter a number between 1 and {len(accessible_models)}.")
            except ValueError:
                print("Invalid input. Enter a number or press Enter for the default.")
            except (KeyboardInterrupt, EOFError):
                print("\nSelection cancelled.")
                sys.exit(1)

        selected_model = accessible_models[selected_idx]

    # Build output
    selected_model_id = selected_model["modelId"]
    cross_region_model_id = (
        f"us.{selected_model_id}"
        if not selected_model_id.startswith("us.")
        else selected_model_id
    )
    selected_name = get_friendly_name(
        selected_model.get("modelName", ""), selected_model_id
    )

    config = {
        "modelId": cross_region_model_id,
        "modelName": selected_name,
    }

    # Write config file
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)
        f.write("\n")

    # Summary
    print(f"\n{BOLD}{'=' * 50}{RESET}")
    print(f"{GREEN}{BOLD}\u2713 Model selected successfully{RESET}")
    print(f"  Model:  {selected_name}")
    print(f"  ID:     {cross_region_model_id}")
    print(f"  Config: {output_path}")
    print(f"{'=' * 50}\n")


if __name__ == "__main__":
    main()
