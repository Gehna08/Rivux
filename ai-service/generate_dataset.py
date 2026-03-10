import json
import random

# -----------------------------
# Severity Definitions
# -----------------------------

severity_1_scenarios = [
    "Users are unable to log in",
    "Payment processing has completely stopped",
    "The production database is unreachable",
    "API is returning 500 errors for all requests",
    "Checkout flow is failing for everyone",
    "Authentication service is not responding",
    "Orders are not being recorded",
    "Main website is showing a blank page",
    "Cloud storage is inaccessible",
    "Search functionality is broken across the platform",
]

severity_2_scenarios = [
    "API responses are noticeably slow",
    "File uploads are taking longer than usual",
    "High CPU usage observed on application server",
    "Database replication lag detected",
    "Intermittent login failures reported",
    "Users reporting occasional timeouts",
    "Dashboard loads slowly during peak hours",
    "Email notifications delayed",
    "Search results loading slower than expected",
    "Some requests are retrying automatically",
]

severity_3_scenarios = [
    "Minor typo found on settings page",
    "Tooltip text is slightly misleading",
    "Profile picture preview is not refreshing immediately",
    "Button alignment slightly off on mobile",
    "Color contrast issue in dark mode",
    "Spacing looks uneven on dashboard cards",
    "Validation message wording could be improved",
    "Dropdown icon appears misaligned",
    "Footer link redirects incorrectly but page works",
    "Help text formatting looks inconsistent",
]

regions = ["in production", "in staging", "in dev environment", "in EU region", "in APAC region", "in US region"]
impact_phrases = [
    "This is affecting multiple customers.",
    "Several users have reported this.",
    "Engineering team is investigating.",
    "Support team escalated the issue.",
    "Business operations are impacted.",
    "Issue was noticed during routine monitoring.",
    "This started after the latest deployment.",
    "Monitoring alerts were triggered.",
    "On-call engineer is looking into it.",
    "Customers are unable to proceed."
]

def generate_sentence(base):
    parts = [
        base,
        random.choice(regions) + ".",
        random.choice(impact_phrases)
    ]
    return " ".join(parts)

def generate_dataset(total=1000):
    data = []
    per_class = total // 3

    # Severity 1
    for _ in range(per_class):
        text = generate_sentence(random.choice(severity_1_scenarios))
        data.append({"text": text, "label": 1})

    # Severity 2
    for _ in range(per_class):
        text = generate_sentence(random.choice(severity_2_scenarios))
        data.append({"text": text, "label": 2})

    # Severity 3
    for _ in range(per_class):
        text = generate_sentence(random.choice(severity_3_scenarios))
        data.append({"text": text, "label": 3})

    random.shuffle(data)
    return data

# -----------------------------
# Generate and Save
# -----------------------------

dataset = generate_dataset(1000)

with open("train_data.json", "w") as f:
    json.dump(dataset, f, indent=2)

print("✅ Generated 1000 balanced incidents in train_data.json")