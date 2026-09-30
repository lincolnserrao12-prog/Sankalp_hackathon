"""Export the Guardian Lens PyTorch image classifier for browser inference."""
from pathlib import Path
import torch
from torchvision import models

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'backend' / 'models' / 'civic_hazard_classifier.pt'
TARGET = ROOT / 'frontend' / 'public' / 'models' / 'guardian-lens-classifier.onnx'

checkpoint = torch.load(SOURCE, map_location='cpu', weights_only=False)
if checkpoint['architecture'] != 'efficientnet_b0':
    raise ValueError(f"Unsupported architecture: {checkpoint['architecture']}")

model = models.efficientnet_b0(weights=None)
model.classifier[1] = torch.nn.Linear(model.classifier[1].in_features, len(checkpoint['classes']))
model.load_state_dict(checkpoint['state_dict'])
model.eval()

TARGET.parent.mkdir(parents=True, exist_ok=True)
sample = torch.randn(1, 3, checkpoint.get('image_size', 224), checkpoint.get('image_size', 224))
torch.onnx.export(
    model,
    sample,
    TARGET,
    input_names=['image'],
    output_names=['logits'],
    dynamic_axes={'image': {0: 'batch'}, 'logits': {0: 'batch'}},
    opset_version=17,
)
print(f'Exported {TARGET}')
