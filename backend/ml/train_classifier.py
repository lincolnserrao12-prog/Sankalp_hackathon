"""Train an edge-friendly civic-hazard image classifier from folder-labelled images."""
from __future__ import annotations

import os
# On Windows, multiple worker processes can each create large OpenBLAS thread
# pools. Keep preprocessing bounded; the CNN itself still runs on CUDA.
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")

import argparse
import json
import random
import re
from collections import Counter
from pathlib import Path

import torch
from torch import nn
from torch.utils.data import DataLoader, Dataset, WeightedRandomSampler
from torchvision import models, transforms
from PIL import Image

SEED = 42
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
HAZARD_LABELS = {"Broken Road Sign Issues":"broken_road_sign","Damaged Road issues":"damaged_road","Illegal Parking Issues":"illegal_parking","Littering Garbage on Public Places Issues":"garbage","Mixed Issues":"mixed_road_issue","Pothole Issues":"pothole","Vandalism Issues":"vandalism"}
# "Mixed Issues" is a catch-all label (only 29 source photos), not one visual
# hazard. Including it makes the classifier learn an incoherent class and gives
# an unstable validation/test score. Reports can still be text-classified as
# unsafe infrastructure when no single visual label is confident.
EXCLUDED_CLASSES = {"Mixed Issues"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, default=Path("../../data/data"))
    parser.add_argument("--output", type=Path, default=Path("runs/civic_hazard_mobilenetv3"))
    parser.add_argument("--model-output", type=Path, default=Path("../models/civic_hazard_classifier.pt"))
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--workers", type=int, default=0,
                        help="Data-loader workers; 0 is safest on Windows.")
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--image-size", type=int, default=224)
    parser.add_argument("--architecture", choices=["efficientnet_b0", "mobilenet_v3_small"], default="efficientnet_b0",
                        help="Pretrained backbone. EfficientNet-B0 is the default accuracy baseline.")
    parser.add_argument("--cache-dir", type=Path, default=Path(".torch-cache"),
                        help="Writable cache for pretrained weights.")
    parser.add_argument("--patience", type=int, default=3,
                        help="Stop after this many epochs without validation macro-F1 improvement.")
    parser.add_argument("--min-epochs", type=int, default=10,
                        help="Train at least this many epochs before early stopping.")
    parser.add_argument("--force-cpu", action="store_true")
    return parser.parse_args()


def discover_samples(root: Path):
    # Dataset folders are grouped by broad area first (e.g. Road Issues) and
    # then by the actual hazard label. A directory containing image files is a
    # class; parent grouping folders are deliberately not labels.
    class_paths = sorted(
        (path for path in root.rglob("*") if path.is_dir()
         and any(child.is_file() and child.suffix.lower() in IMAGE_EXTENSIONS
                 for child in path.iterdir()) and path.name not in EXCLUDED_CLASSES),
        key=lambda path: path.name,
    )
    classes = [path.name for path in class_paths]
    if len(classes) < 2 or len(classes) != len(set(classes)):
        raise ValueError(f"Expected uniquely named leaf class folders in {root.resolve()}; found {classes}")
    mapping = {name: index for index, name in enumerate(classes)}
    samples = []
    for class_path in class_paths:
        for path in sorted(class_path.iterdir()):
            if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS:
                samples.append((path, mapping[class_path.name]))
    unknown = set(classes) - set(HAZARD_LABELS)
    if unknown: raise ValueError(f"Add API hazard labels for dataset folders: {sorted(unknown)}")
    return classes, samples

def source_group(path: Path) -> str:
    """Keep Roboflow augmentations of one source photo in the same split."""
    return re.sub(r"_(?:jpe?g|png|webp)\.rf\.[^.]+$", "", path.stem, flags=re.IGNORECASE)


def stratified_split(samples, classes):
    by_class = {i: [] for i in range(len(classes))}
    for sample in samples:
        by_class[sample[1]].append(sample)
    rng = random.Random(SEED)
    splits = {"train": [], "val": [], "test": []}
    for label, group in by_class.items():
        grouped = {}
        for sample in group: grouped.setdefault(source_group(sample[0]), []).append(sample)
        groups = list(grouped.values())
        if len(groups) < 3: raise ValueError(f"Class {classes[label]!r} needs at least three distinct source images.")
        rng.shuffle(groups); n_test=max(1,round(len(groups)*.15)); n_val=max(1,round(len(groups)*.15))
        if n_test+n_val>=len(groups): n_test=n_val=1
        for name, selected in (("test",groups[:n_test]),("val",groups[n_test:n_test+n_val]),("train",groups[n_test+n_val:])): splits[name].extend(sample for source in selected for sample in source)
    return splits


class SamplesDataset(Dataset):
    def __init__(self, samples, transform):
        self.samples, self.transform = samples, transform

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, index):
        path, label = self.samples[index]
        with Image.open(path) as image:
            return self.transform(image.convert("RGB")), label


def evaluate(model, loader, criterion, device, class_count):
    model.eval()
    total_loss = correct = total = 0
    per_class_total = [0] * class_count
    per_class_correct = [0] * class_count
    predicted_total = [0] * class_count
    with torch.inference_mode():
        for images, labels in loader:
            images, labels = images.to(device), labels.to(device)
            logits = model(images)
            total_loss += criterion(logits, labels).item() * labels.size(0)
            predictions = logits.argmax(1)
            correct += (predictions == labels).sum().item()
            total += labels.size(0)
            for label, prediction in zip(labels.tolist(), predictions.tolist()):
                per_class_total[label] += 1
                per_class_correct[label] += int(label == prediction)
                predicted_total[prediction] += 1
    recalls = [per_class_correct[i] / max(1, per_class_total[i]) for i in range(class_count)]
    precisions = [per_class_correct[i] / max(1, predicted_total[i]) for i in range(class_count)]
    f1s = [2 * precisions[i] * recalls[i] / max(1e-12, precisions[i] + recalls[i]) for i in range(class_count)]
    return {"loss": total_loss / total, "accuracy": correct / total, "macro_recall": sum(recalls) / class_count, "macro_f1": sum(f1s) / class_count, "per_class_recall": recalls, "per_class_precision": precisions, "per_class_f1": f1s}


def build_model(architecture: str, class_count: int, pretrained: bool):
    if architecture == "efficientnet_b0":
        model = models.efficientnet_b0(weights=models.EfficientNet_B0_Weights.DEFAULT if pretrained else None)
        model.classifier[1] = nn.Linear(model.classifier[1].in_features, class_count)
    else:
        model = models.mobilenet_v3_small(weights=models.MobileNet_V3_Small_Weights.DEFAULT if pretrained else None)
        model.classifier[3] = nn.Linear(model.classifier[3].in_features, class_count)
    return model


def main():
    args = parse_args()
    torch.set_num_threads(1)
    random.seed(SEED); torch.manual_seed(SEED)
    if torch.cuda.is_available(): torch.cuda.manual_seed_all(SEED)
    device = torch.device("cpu" if args.force_cpu else "cuda" if torch.cuda.is_available() else "cpu")
    if not args.force_cpu and device.type != "cuda":
        raise RuntimeError("CUDA GPU is required. Run setup_training.ps1 first; use --force-cpu only for debugging.")
    args.data = args.data.resolve(); args.output = args.output.resolve(); args.model_output = args.model_output.resolve(); args.cache_dir = args.cache_dir.resolve(); args.output.mkdir(parents=True, exist_ok=True); args.model_output.parent.mkdir(parents=True, exist_ok=True); args.cache_dir.mkdir(parents=True, exist_ok=True); torch.hub.set_dir(str(args.cache_dir))
    classes, samples = discover_samples(args.data)
    splits = stratified_split(samples, classes)
    print(f"Classes ({len(classes)}): {', '.join(classes)}")
    image_size = args.image_size
    train_transform = transforms.Compose([transforms.Resize((image_size, image_size)), transforms.RandomHorizontalFlip(), transforms.RandomRotation(12), transforms.ColorJitter(0.15, 0.15, 0.1), transforms.ToTensor(), transforms.Normalize((0.485, 0.456, 0.406), (0.229, 0.224, 0.225))])
    eval_transform = transforms.Compose([transforms.Resize((image_size, image_size)), transforms.ToTensor(), transforms.Normalize((0.485, 0.456, 0.406), (0.229, 0.224, 0.225))])
    train_set = SamplesDataset(splits["train"], train_transform)
    val_set = SamplesDataset(splits["val"], eval_transform)
    test_set = SamplesDataset(splits["test"], eval_transform)
    counts = Counter(label for _, label in splits["train"])
    weights = [1 / counts[label] for _, label in splits["train"]]
    loader_args = {"num_workers": args.workers, "pin_memory": device.type == "cuda", "persistent_workers": args.workers > 0}
    train_loader = DataLoader(train_set, batch_size=args.batch_size, sampler=WeightedRandomSampler(weights, len(weights), replacement=True), **loader_args)
    val_loader = DataLoader(val_set, batch_size=args.batch_size, shuffle=False, **loader_args)
    test_loader = DataLoader(test_set, batch_size=args.batch_size, shuffle=False, **loader_args)
    try: model = build_model(args.architecture, len(classes), pretrained=True)
    except Exception as error:
        print(f"Could not fetch ImageNet weights ({error}); training from scratch.")
        model = build_model(args.architecture, len(classes), pretrained=False)
    model.to(device)
    criterion = nn.CrossEntropyLoss(label_smoothing=0.05)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs)
    scaler = torch.amp.GradScaler("cuda", enabled=device.type == "cuda")
    best_macro_f1 = -1.0; stale_epochs = 0
    print(f"Training on {device}: {torch.cuda.get_device_name(0) if device.type == 'cuda' else 'CPU'}")
    for epoch in range(1, args.epochs + 1):
        model.train(); total_loss = 0.0
        for images, labels in train_loader:
            images, labels = images.to(device), labels.to(device)
            optimizer.zero_grad(set_to_none=True)
            with torch.amp.autocast("cuda", enabled=device.type == "cuda"):
                loss = criterion(model(images), labels)
            scaler.scale(loss).backward(); scaler.step(optimizer); scaler.update()
            total_loss += loss.item() * labels.size(0)
        scheduler.step()
        metrics = evaluate(model, val_loader, criterion, device, len(classes))
        print(f"epoch {epoch:02d}/{args.epochs} train_loss={total_loss / len(train_set):.4f} val_loss={metrics['loss']:.4f} val_acc={metrics['accuracy']:.4f} macro_f1={metrics['macro_f1']:.4f} macro_recall={metrics['macro_recall']:.4f}")
        if metrics["macro_f1"] > best_macro_f1 + 1e-4:
            best_macro_f1 = metrics["macro_f1"]; stale_epochs = 0
            torch.save({"architecture": args.architecture, "classes": classes, "hazard_labels": [HAZARD_LABELS[name] for name in classes], "image_size": image_size, "normalization": "imagenet", "state_dict": model.state_dict()}, args.output / "best.pt")
        elif epoch >= args.min_epochs:
            stale_epochs += 1
            if stale_epochs >= args.patience:
                print(f"Early stopping at epoch {epoch}: no validation macro-F1 improvement for {args.patience} epochs.")
                break
    checkpoint = torch.load(args.output / "best.pt", map_location=device, weights_only=False)
    model.load_state_dict(checkpoint["state_dict"])
    results = evaluate(model, test_loader, criterion, device, len(classes))
    results["classes"] = classes
    results["split_counts"] = {name: dict(Counter(classes[label] for _, label in group)) for name, group in splits.items()}
    (args.output / "metrics.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    torch.save(checkpoint, args.output / "civic_hazard_classifier.pt")
    torch.save(checkpoint, args.model_output)
    print("Saved:", args.output / "civic_hazard_classifier.pt")
    print("Saved deployment model:", args.model_output)
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
