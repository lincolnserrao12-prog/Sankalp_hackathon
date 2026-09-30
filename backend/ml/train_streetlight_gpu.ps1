param([int]$Epochs = 40, [int]$BatchSize = 256, [int]$Patience = 3)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $root ".venv\\Scripts\\python.exe"
if (-not (Test-Path $python)) { & (Join-Path $root "setup_training.ps1") }
& $python -m pip install -r (Join-Path $root "requirements.txt")
& $python (Join-Path $root "train_streetlight.py") --data (Join-Path $root "..\\..\\archive\\street_light_fault_prediction_dataset.csv") --output (Join-Path $root "runs\\streetlight_fault_mlp") --epochs $Epochs --batch-size $BatchSize --patience $Patience
