param(
  [string]$Python = "python"
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$venv = Join-Path $scriptRoot ".venv"

& $Python -m venv $venv
$pythonExe = Join-Path $venv "Scripts\\python.exe"
& $pythonExe -m pip install --upgrade pip

# CUDA 12.8 wheel: uses the locally installed NVIDIA driver and RTX GPU.
& $pythonExe -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
& $pythonExe -m pip install -r (Join-Path $scriptRoot "requirements.txt")
& $pythonExe -c "import torch; assert torch.cuda.is_available(), 'CUDA PyTorch was not detected. Update the NVIDIA driver, then rerun this script.'; print('GPU training ready:', torch.cuda.get_device_name(0))"
