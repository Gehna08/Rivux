# Import FastAPI to create the API server
from fastapi import FastAPI

# Import BaseModel to define request data structure
from pydantic import BaseModel

# Import PyTorch (deep learning library)
import torch

# Import trained BERT classifier + tokenizer
from transformers import BertTokenizer, BertForSequenceClassification


# -----------------------------------------
# 1️⃣ Create FastAPI App
# -----------------------------------------

app = FastAPI()


# -----------------------------------------
# 2️⃣ Define Request Body Structure
# -----------------------------------------
# This ensures the client sends JSON like:
# { "text": "Server is down" }

class Incident(BaseModel):
    text: str


# -----------------------------------------
# 3️⃣ Load Trained Model + Tokenizer
# -----------------------------------------

# Detect whether GPU is available, otherwise use CPU
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

# Keep using the classification class!
tokenizer = BertTokenizer.from_pretrained("./model")
model = BertForSequenceClassification.from_pretrained("./model")

# Move model to GPU or CPU
model.to(device)

# Set model to evaluation mode (very important for inference)
model.eval()


# -----------------------------------------
# 4️⃣ Health Check Route
# -----------------------------------------

@app.get("/")
def root():
    # Simple check to confirm API is running
    return {"message": "AI Service is Online"}


# -----------------------------------------
# 5️⃣ Main Prediction Endpoint
# -----------------------------------------

@app.post("/analyze")
def analyze(incident: Incident):

    # -------- Step 1: Convert text → numbers --------
    inputs = tokenizer(
        incident.text,            # user input text
        return_tensors="pt",      # return PyTorch tensors
        truncation=True,          # cut text if too long
        padding=True,             # pad if too short
        max_length=128            # maximum token length
    )

    # Move input tensors to same device as model
    inputs = {k: v.to(device) for k, v in inputs.items()}

    # -------- Step 2: Run model without training --------
    with torch.no_grad():  # disables gradient calculation (faster + saves memory)

        # Get outputs + hidden states for embeddings
        outputs = model(**inputs, output_hidden_states=True)

    # -------- Step 3: Get Severity Prediction --------

    # Logits = raw prediction scores
    logits = outputs.logits

    # Get index of highest score (0,1,2)
    predicted_class = torch.argmax(logits, dim=1).item()

    # Convert 0,1,2 → 1,2,3 (your original severity labels)
    severity = predicted_class + 1


    # -------- Step 4: Generate Embedding Vector --------

    # Get last hidden layer from BERT
    last_hidden_state = outputs.hidden_states[-1]

    # Take mean of all word vectors → single sentence vector
    embeddings = last_hidden_state.mean(dim=1).squeeze().tolist()


    # -------- Step 5: Return JSON Response --------

    return {
        "severity": severity,     # ML-predicted severity
        "embedding": embeddings   # vector for pgvector similarity search
    }


# -----------------------------------------
# 6️⃣ Run Server
# -----------------------------------------

if __name__ == "__main__":
    import uvicorn

    # Run FastAPI using ASGI server
    uvicorn.run(app, host="0.0.0.0", port=8000)