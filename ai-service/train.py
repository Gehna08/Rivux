import json
import torch
from torch.utils.data import Dataset, DataLoader
from transformers import BertTokenizer, BertForSequenceClassification
from torch.optim import AdamW
from sklearn.model_selection import train_test_split
from tqdm import tqdm

# -----------------------
# 1️⃣ Load Data
# -----------------------
with open("train_data.json", "r") as f:
    data = json.load(f)

texts = [item["text"] for item in data]
# Convert 1,2,3 → 0,1,2
labels = [item["label"] - 1 for item in data]

# Safety check
if min(labels) < 0 or max(labels) > 2:
    raise ValueError("Labels must be 1,2,3 in train_data.json")

train_texts, val_texts, train_labels, val_labels = train_test_split(
    texts, labels, test_size=0.2, random_state=42
)

# -----------------------
# 2️⃣ Tokenizer
# -----------------------
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

train_loader = DataLoader(train_dataset, batch_size=8, shuffle=True)
val_loader = DataLoader(val_dataset, batch_size=8)

# -----------------------
# 3️⃣ Model
# -----------------------
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

model = BertForSequenceClassification.from_pretrained(
    "bert-base-uncased",
    num_labels=3
)

model.to(device)
optimizer = AdamW(model.parameters(), lr=2e-5)

# -----------------------
# 4️⃣ Training Loop
# -----------------------
epochs = 8

for epoch in range(epochs):
    model.train()
    total_loss = 0

    for batch in tqdm(train_loader):
        optimizer.zero_grad()

        batch = {k: v.to(device) for k, v in batch.items()}
        outputs = model(**batch)

        loss = outputs.loss
        total_loss += loss.item()

        loss.backward()
        optimizer.step()

    avg_loss = total_loss / len(train_loader)
    print(f"\nEpoch {epoch+1}/{epochs} - Training Loss: {avg_loss:.4f}")

# -----------------------
# 5️⃣ Save Model
# -----------------------
model.save_pretrained("./model")
tokenizer.save_pretrained("./model")

print("\n✅ Training complete!")
print("📁 Model saved inside ./model/")