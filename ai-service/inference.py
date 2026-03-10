from fastapi import FastAPI
from pydantic import BaseModel
import torch
from transformers import BertTokenizer, BertForSequenceClassification, BertModel

app = FastAPI()

# Load your trained model and the base model for embeddings
model_path = "./model"
tokenizer = BertTokenizer.from_pretrained(model_path)
class_model = BertForSequenceClassification.from_pretrained(model_path)
base_model = BertModel.from_pretrained("bert-base-uncased") # For embeddings

class IncidentText(BaseModel):
    text: str

@app.post("/analyze")
async def analyze_incident(data: IncidentText):
    inputs = tokenizer(data.text, return_tensors="pt", truncation=True, padding=True, max_length=128)
    
    # 1. Get Severity Prediction
    with torch.no_grad():
        outputs = class_model(**inputs)
        severity = torch.argmax(outputs.logits, dim=1).item() + 1
        
    # 2. Get Vector Embedding (Root Cause Analysis)
    with torch.no_grad():
        base_outputs = base_model(**inputs)
        # Use the mean of the last hidden state as the "fingerprint"
        embedding = base_outputs.last_hidden_state.mean(dim=1).squeeze().tolist()

    return {
        "severity": severity,
        "embedding": embedding
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=5001)