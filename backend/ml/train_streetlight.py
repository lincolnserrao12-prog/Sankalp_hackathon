"""GPU training for the archive street-light fault telemetry dataset."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
import torch
from sklearn.metrics import accuracy_score, classification_report, f1_score
from sklearn.preprocessing import StandardScaler
from torch import nn
from torch.utils.data import DataLoader, TensorDataset


def args():
    p = argparse.ArgumentParser()
    p.add_argument("--data", type=Path, default=Path("../../archive/street_light_fault_prediction_dataset.csv"))
    p.add_argument("--output", type=Path, default=Path("runs/streetlight_fault_mlp"))
    p.add_argument("--epochs", type=int, default=40)
    p.add_argument("--batch-size", type=int, default=256)
    p.add_argument("--patience", type=int, default=3,
                   help="Stop after this many epochs without validation macro-F1 improvement.")
    return p.parse_args()


def prepare(path: Path):
    frame = pd.read_csv(path)
    frame["timestamp"] = pd.to_datetime(frame["timestamp"], errors="coerce")
    if frame.isna().any().any():
        raise ValueError("Dataset has missing/unparseable values; clean them before training.")
    # Timestamp components are available when a report is made, unlike the
    # target fault type, so they are safe predictive features.
    frame["hour"] = frame.timestamp.dt.hour
    frame["day_of_week"] = frame.timestamp.dt.dayofweek
    frame["month"] = frame.timestamp.dt.month
    categorical = pd.get_dummies(frame["environmental_conditions"], prefix="weather", dtype=float)
    numeric_names = ["bulb_number", "power_consumption (Watts)", "voltage_levels (Volts)",
                     "current_fluctuations (Amperes)", "temperature (Celsius)",
                     "current_fluctuations_env (Amperes)", "hour", "day_of_week", "month"]
    features = pd.concat([frame[numeric_names].astype(float), categorical], axis=1)
    # Chronological splits simulate prediction on later telemetry, avoiding a
    # random same-period evaluation leak.
    ordered = frame.assign(_row=np.arange(len(frame))).sort_values("timestamp")
    split_a, split_b = int(len(ordered) * .70), int(len(ordered) * .85)
    indices = [ordered._row.iloc[:split_a].to_numpy(), ordered._row.iloc[split_a:split_b].to_numpy(), ordered._row.iloc[split_b:].to_numpy()]
    labels = frame["fault_type"].astype(int).to_numpy()
    return features, labels, indices


class FaultNet(nn.Module):
    def __init__(self, width, classes):
        super().__init__()
        self.layers = nn.Sequential(nn.Linear(width, 128), nn.ReLU(), nn.BatchNorm1d(128), nn.Dropout(.20), nn.Linear(128, 64), nn.ReLU(), nn.Dropout(.10), nn.Linear(64, classes))
    def forward(self, x): return self.layers(x)


def evaluate(model, loader, device):
    model.eval(); predicted = []; actual = []
    with torch.inference_mode():
        for x, y in loader:
            predicted.extend(model(x.to(device)).argmax(1).cpu().tolist()); actual.extend(y.tolist())
    return actual, predicted


def main():
    cfg = args(); torch.manual_seed(42); torch.set_num_threads(1)
    if not torch.cuda.is_available(): raise RuntimeError("CUDA GPU not available. Use setup_training.ps1 first.")
    device = torch.device("cuda"); cfg.data = cfg.data.resolve(); cfg.output = cfg.output.resolve(); cfg.output.mkdir(parents=True, exist_ok=True)
    X, y, (train_i, val_i, test_i) = prepare(cfg.data)
    scaler = StandardScaler(); X_train = scaler.fit_transform(X.iloc[train_i]); X_val = scaler.transform(X.iloc[val_i]); X_test = scaler.transform(X.iloc[test_i])
    classes = sorted(np.unique(y).tolist()); class_to_index = {value: index for index, value in enumerate(classes)}; y = np.array([class_to_index[value] for value in y])
    def loader(values, labels, shuffle=False): return DataLoader(TensorDataset(torch.tensor(values, dtype=torch.float32), torch.tensor(labels, dtype=torch.long)), batch_size=cfg.batch_size, shuffle=shuffle, pin_memory=True)
    train, val, test = loader(X_train, y[train_i], True), loader(X_val, y[val_i]), loader(X_test, y[test_i])
    weights = torch.tensor([len(y[train_i]) / (len(classes) * max(1, (y[train_i] == i).sum())) for i in range(len(classes))], dtype=torch.float32, device=device)
    model = FaultNet(X.shape[1], len(classes)).to(device); loss_fn = nn.CrossEntropyLoss(weight=weights); opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4); best = -1.0; stale_epochs = 0
    print(f"Training street-light fault model on {torch.cuda.get_device_name(0)}; {X.shape[1]} features, {len(classes)} classes")
    for epoch in range(1, cfg.epochs + 1):
        model.train()
        for x, target in train:
            opt.zero_grad(set_to_none=True); loss = loss_fn(model(x.to(device)), target.to(device)); loss.backward(); opt.step()
        actual, predicted = evaluate(model, val, device); macro_f1 = f1_score(actual, predicted, average="macro", zero_division=0)
        print(f"epoch {epoch:02d}/{cfg.epochs} val_accuracy={accuracy_score(actual, predicted):.4f} val_macro_f1={macro_f1:.4f}")
        if macro_f1 > best + 1e-4:
            best = macro_f1; stale_epochs = 0
            torch.save({"state_dict": model.state_dict(), "feature_names": X.columns.tolist(), "classes": classes, "scaler_mean": scaler.mean_.tolist(), "scaler_scale": scaler.scale_.tolist()}, cfg.output / "best.pt")
        else:
            stale_epochs += 1
            if stale_epochs >= cfg.patience:
                print(f"Early stopping at epoch {epoch}: no macro-F1 improvement for {cfg.patience} epochs.")
                break
    checkpoint = torch.load(cfg.output / "best.pt", map_location=device, weights_only=False); model.load_state_dict(checkpoint["state_dict"])
    actual, predicted = evaluate(model, test, device)
    metrics = {"test_accuracy": accuracy_score(actual, predicted), "test_macro_f1": f1_score(actual, predicted, average="macro", zero_division=0), "report": classification_report(actual, predicted, labels=list(range(len(classes))), target_names=[str(c) for c in classes], output_dict=True, zero_division=0), "splits": {"train": len(train_i), "val": len(val_i), "test": len(test_i)}}
    (cfg.output / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8"); torch.save(checkpoint, cfg.output / "streetlight_fault_model.pt")
    print("Saved:", cfg.output / "streetlight_fault_model.pt"); print(json.dumps(metrics, indent=2))

if __name__ == "__main__": main()
