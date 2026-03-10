import json
import torch
from torch.utils.data import Dataset
from transformers import (
    BertTokenizer,
    BertForSequenceClassification,
    Trainer,
    TrainingArguments
)
from sklearn.model_selection import train_test_split
import numpy as np

# ----------------------------
# 1️⃣ Load Training Data
# ----------------------------
with open("train_data.json", "r") as f:
    data = json.load(f)

texts = [item["text"] for item in data]

# Convert 1,2,3 → 0,1,2 for model training
labels = [item["label"] - 1 for item in data]

# Safety check
if min(labels) < 0 or max(labels) > 2:
    raise ValueError("Labels must be 1,2,3 in dataset.")

# Split into train and validation
train_texts, val_texts, train_labels, val_labels = train_test_split(
    texts, labels, test_size=0.2, random_state=42
)

# ----------------------------
# 2️⃣ Load Tokenizer
# ----------------------------
tokenizer = BertTokenizer.from_pretrained("bert-base-uncased")

class IncidentDataset(Dataset):
    def __init__(self, texts, labels):
        self.encodings = tokenizer(
            texts,
            truncation=True,
            padding=True,
            max_length=128
        )
        self.labels = labels

    def __getitem__(self, idx):
        item = {key: torch.tensor(val[idx]) for key, val in self.encodings.items()}
        item["labels"] = torch.tensor(self.labels[idx])
        return item

    def __len__(self):
        return len(self.labels)

train_dataset = IncidentDataset(train_texts, train_labels)
val_dataset = IncidentDataset(val_texts, val_labels)

# ----------------------------
# 3️⃣ Load Model
# ----------------------------
model = BertForSequenceClassification.from_pretrained(
    "bert-base-uncased",
    num_labels=3
)

# ----------------------------
# 4️⃣ Training Arguments
# ----------------------------
training_args = TrainingArguments(
    output_dir="./results",
    num_train_epochs=5,
    per_device_train_batch_size=8,
    per_device_eval_batch_size=8,
    evaluation_strategy="epoch",
    save_strategy="epoch",
    logging_dir="./logs",
    logging_steps=10,
    load_best_model_at_end=True,
    save_total_limit=1
)

# ----------------------------
# 5️⃣ Trainer
# ----------------------------
trainer = Trainer(
    model=model,
    args=training_args,
    train_dataset=train_dataset,
    eval_dataset=val_dataset
)

# ----------------------------
# 6️⃣ Train Model
# ----------------------------
trainer.train()

# ----------------------------
# 7️⃣ Save Model
# ----------------------------
model.save_pretrained("./model")
tokenizer.save_pretrained("./model")

print("\n✅ Model training complete!")
print("📁 Model saved inside ./model folder")