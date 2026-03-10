from transformers import BertTokenizer, BertForSequenceClassification

# Use the exact class your project needs
tokenizer = BertTokenizer.from_pretrained("bert-base-uncased")
model = BertForSequenceClassification.from_pretrained("bert-base-uncased", num_labels=3) # Adjust num_labels to your training

tokenizer.save_pretrained("./model")
model.save_pretrained("./model")