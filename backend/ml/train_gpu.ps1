param(
  [int]$Epochs = 20,
  # EfficientNet-B0 training fits reliably on the project's 8 GB RTX 4060.
  [int]$BatchSize = 8,
  [int]$Workers = 0,
  [int]$Patience = 3,
  [int]$MinEpochs = 10,
  [ValidateSet("efficientnet_b0", "mobilenet_v3_small")]
  [string]$Architecture = "efficientnet_b0"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonExe = Join-Path $root ".venv\\Scripts\\python.exe"

# First invocation provisions an isolated CUDA-enabled PyTorch environment;
# subsequent invocations immediately resume normal GPU training.
if (-not (Test-Path $pythonExe)) {
  & (Join-Path $root "setup_training.ps1")
}

& (Join-Path $root ".venv\\Scripts\\python.exe") (Join-Path $root "train_classifier.py") --data (Join-Path $root "..\\..\\data\\data") --output (Join-Path $root "runs\\civic_hazard_classifier") --model-output (Join-Path $root "..\\models\\civic_hazard_classifier.pt") --architecture $Architecture --epochs $Epochs --batch-size $BatchSize --workers $Workers --patience $Patience --min-epochs $MinEpochs
